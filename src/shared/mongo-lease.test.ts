import type { Collection, Filter, UpdateFilter } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CollectionSource,
  LEASE_COLLECTION,
  type LeaseDocument,
  MemoryLease,
  MongoLease,
} from "./mongo-lease.js";

// CONTRA UN DOBLE DEL DRIVER QUE SÍ ES ATÓMICO, y no contra un Mongo de verdad, por la misma razón
// que `mongo-repository.test.ts` y `mongo-history.test.ts`: `vitest.setup.ts` BORRA `MONGO_URI` a
// propósito, así que la suite no depende de ningún servicio externo y eso es una propiedad del repo
// y no del shell de quien la corre.
//
// Acá el doble TIENE QUE TENER COMPORTAMIENTO, y de un tipo muy concreto: lo único que este archivo
// mide es una carrera. `findOneAndUpdate` y `deleteOne` aplican su lectura y su escritura en el
// MISMO turno del event loop —sin un solo `await` en el medio—, que es lo que el documento único de
// Mongo garantiza. Es justo esa propiedad la que hace que un adaptador escrito como
// "leo, decido, escribo" se ponga rojo acá: dos `within` concurrentes que se cedan el turno entre
// la lectura y la escritura entran los dos.

const TTL = 15_000;
const BASE_INSTANT = Date.UTC(2026, 8, 15, 12, 0, 0);

function mutableClock() {
  let current = BASE_INSTANT;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// UN TRABAJO QUE AVISA CUÁNDO ENTRÓ Y ESPERA A QUE LO SUELTEN. Sin el aviso, las aserciones de
// carrera dependerían de cuántos microtasks tarda `within` en adquirir, que es exactamente el tipo
// de test que se pone verde solo el día que el adaptador agrega un `await`.
function blockingWork<T>(value: T) {
  const entered = deferred();
  const released = deferred();
  return {
    entered: entered.promise,
    release: released.resolve,
    work: async () => {
      entered.resolve();
      await released.promise;
      return value;
    },
  };
}

type Stored = { _id: string; owner: string; until: Date };

// El recorte de filtros que este adaptador usa, y nada más: igualdad de primer nivel (`_id`,
// `owner`), `$lte` sobre la fecha y el `$or` de las dos condiciones de adquisición. Un doble con
// operadores que nadie llama es código que puede estar mal sin que nada lo note.
function matches(stored: Stored, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Record<string, unknown>[]).some((branch) => matches(stored, branch));
    }
    const value = (stored as unknown as Record<string, unknown>)[key];
    const bound = lowerOrEqual(condition);
    if (bound) return (value as Date).getTime() <= bound.getTime();
    return value === condition;
  });
}

function lowerOrEqual(condition: unknown): Date | undefined {
  if (typeof condition !== "object" || condition === null) return undefined;
  const bound = (condition as { $lte?: unknown }).$lte;
  return bound instanceof Date ? bound : undefined;
}

function fakeLeases() {
  const documents = new Map<string, Stored>();

  const collection = {
    findOneAndUpdate: vi.fn(
      async (
        filter: Filter<LeaseDocument>,
        update: UpdateFilter<LeaseDocument>,
        options?: { upsert?: boolean },
      ) => {
        const id = (filter as { _id?: string })._id;
        const current = id === undefined ? undefined : documents.get(id);
        if (current && matches(current, filter as Record<string, unknown>)) {
          const after = { ...current, ...(update.$set ?? {}) } as Stored;
          documents.set(after._id, after);
          // El doble NO modela `returnDocument`, porque el adaptador no lo manda: lo que decide si
          // se adquirió es que esto no haya lanzado. Un doble que ramificara sobre una opción que
          // nadie pasa es código que puede estar mal sin que nada lo note.
          return after;
        }
        if (!options?.upsert) return null;
        // EL INSERT DEL UPSERT DERIVA EL `_id` DE LA IGUALDAD DEL FILTRO, así que cuando el
        // documento ya existe y el `$or` no lo eligió, Mongo intenta insertar un `_id` repetido y
        // devuelve E11000. O sea: el duplicado NO es una rareza de carrera, es el camino ORDINARIO
        // de "lo tiene otro". El mensaje trae el nombre del índice y la versión del servidor; lo
        // único estable es el código.
        if (current) {
          throw Object.assign(
            new Error(
              'E11000 duplicate key error collection: test.game_mode_leases index: _id_ dup key: { _id: "catalog" }',
            ),
            { code: 11000 },
          );
        }
        const inserted = { _id: id as string, ...(update.$set ?? {}) } as Stored;
        documents.set(inserted._id, inserted);
        return inserted;
      },
    ),
    deleteOne: vi.fn(async (filter: Filter<LeaseDocument>) => {
      const id = (filter as { _id?: string })._id;
      const current = id === undefined ? undefined : documents.get(id);
      if (current && matches(current, filter as Record<string, unknown>)) {
        documents.delete(id as string);
        return { acknowledged: true, deletedCount: 1 };
      }
      return { acknowledged: true, deletedCount: 0 };
    }),
  };

  const collectionOf = vi.fn(async (_name: string) => collection as unknown as Collection<never>);
  return {
    source: { collection: collectionOf } as unknown as CollectionSource,
    collection,
    collectionOf,
    documents,
  };
}

function harness() {
  const clock = mutableClock();
  const fake = fakeLeases();
  // TRES DUEÑOS SOBRE LA MISMA "BASE", que es lo que simula tres procesos: el UUID de dueño se
  // genera por INSTANCIA, así que dos `MongoLease` distintos sobre la misma colección son
  // exactamente dos despliegues peleando por el mismo lease.
  return {
    clock,
    ...fake,
    a: new MongoLease(fake.source, clock),
    b: new MongoLease(fake.source, clock),
    c: new MongoLease(fake.source, clock),
  };
}

describe("MongoLease: la exclusión entre procesos", () => {
  it("sólo un dueño entra cuando dos compiten por el mismo nombre", async () => {
    const { a, b } = harness();
    const held = blockingWork("trabajo-de-a");
    const started: string[] = [];

    // LOS DOS SE LANZAN EN EL MISMO TURNO, sin esperar a que el primero haya entrado, y ése es el
    // punto entero del test: si se esperara, la segunda adquisición encontraría el lease ya escrito
    // y hasta un adaptador de "leo, decido, escribo" pasaría. Lanzados juntos, las dos lecturas caen
    // antes que las dos escrituras, y sólo una operación ATÓMICA excluye.
    const first = a.within("catalog", TTL, async () => {
      started.push("a");
      return held.work();
    });
    const second = b.within("catalog", TTL, async () => {
      started.push("b");
      return "trabajo-de-b";
    });

    // `undefined` Y NO UN THROW, y es el detalle del contrato del que cuelgan los dos consumidores:
    // el servicio del catálogo lo convierte en 503 y el dispatcher se saltea el tick. Un `within`
    // que lanzara haría que un catálogo ocupado se viera como una caída.
    await expect(second).resolves.toBeUndefined();
    expect(started).toEqual(["a"]);

    held.release();
    await expect(first).resolves.toBe("trabajo-de-a");
  });

  it("el segundo recupera el lock recién cuando el lease vence", async () => {
    const { a, b, clock } = harness();
    const held = blockingWork("trabajo-de-a");
    const first = a.within("catalog", TTL, held.work);
    await held.entered;

    // Un milisegundo antes del vencimiento sigue siendo de `a`, aunque `a` no haya terminado nunca.
    clock.advance(TTL - 1);
    await expect(b.within("catalog", TTL, async () => "trabajo-de-b")).resolves.toBeUndefined();

    // Y en el vencimiento EXACTO ya se puede tomar: `until` es el instante en que deja de valer, no
    // el último en que vale. Pinea el `$lte` del filtro — con `$lt` esta línea se pone roja.
    clock.advance(1);
    await expect(b.within("catalog", TTL, async () => "trabajo-de-b")).resolves.toBe(
      "trabajo-de-b",
    );

    held.release();
    await first;
  });

  // LA ASERCIÓN MÁS PELIGROSA DEL ARCHIVO. Un dueño cuyo lease venció mientras trabajaba NO puede
  // borrar, al salir, el lease que ya tomó otro: si lo hiciera, el tercero entraría creyendo que
  // está libre y habría dos escritores del catálogo sin que nada falle. Lo que lo impide es que el
  // borrado lleve el `owner` en el filtro.
  it("un dueño vencido no libera el lease del que lo reemplazó", async () => {
    const { a, b, c, clock, documents } = harness();
    const heldByA = blockingWork("trabajo-de-a");
    const first = a.within("catalog", TTL, heldByA.work);
    await heldByA.entered;

    clock.advance(TTL);
    const heldByB = blockingWork("trabajo-de-b");
    const second = b.within("catalog", TTL, heldByB.work);
    await heldByB.entered;
    const ownerWhileB = documents.get("catalog")?.owner;

    // `a` sale AHORA, con el lease ya en manos de `b`.
    heldByA.release();
    await expect(first).resolves.toBe("trabajo-de-a");

    expect(documents.get("catalog")?.owner).toBe(ownerWhileB);
    await expect(c.within("catalog", TTL, async () => "trabajo-de-c")).resolves.toBeUndefined();

    heldByB.release();
    await expect(second).resolves.toBe("trabajo-de-b");
  });

  it("libera con el dueño en el filtro y no sólo con el nombre", async () => {
    const { a, collection } = harness();

    await a.within("catalog", TTL, async () => "listo");

    const [filter] = collection.deleteOne.mock.calls[0] ?? [];
    expect(filter).toEqual({ _id: "catalog", owner: expect.any(String) });
  });

  // UN TRABAJO QUE FALLA NO ES UN LEASE QUE FALLA: el error sube tal cual —el llamador tiene que
  // poder distinguir "ocupado" (`undefined`) de "explotó"— y el lease se libera igual. Sin la
  // liberación, un error del catálogo dejaría la escritura bloqueada quince segundos.
  it("un trabajo que falla libera el lease y el error sube", async () => {
    const { a, b, documents } = harness();

    await expect(
      a.within("catalog", TTL, async () => {
        throw new Error("el catálogo explotó");
      }),
    ).rejects.toThrow("el catálogo explotó");

    expect(documents.has("catalog")).toBe(false);
    await expect(b.within("catalog", TTL, async () => "trabajo-de-b")).resolves.toBe(
      "trabajo-de-b",
    );
  });

  // LA LIBERACIÓN QUE FALLA DESPUÉS DE UN TRABAJO EXITOSO SÍ SUBE: el trabajo salió bien y lo único
  // roto es la base, así que decirlo es la respuesta honesta. El llamador ve un 503 sobre un cambio
  // que puede haber quedado aplicado, y releer el catálogo antes de reintentar es su parte.
  it("un fallo al liberar después de un trabajo exitoso sube", async () => {
    const { a, collection } = harness();
    collection.deleteOne.mockRejectedValueOnce(new Error("sin conexión"));

    await expect(a.within("catalog", TTL, async () => "listo")).rejects.toThrow("sin conexión");
  });

  // Y NO TAPA EL ERROR DEL TRABAJO cuando fallan los dos. Reemplazar "el catálogo explotó" por "no
  // pude borrar el lease" manda a soporte a mirar la pieza equivocada, y el vencimiento ya es la red
  // de contención del lease que quedó colgado.
  it("un fallo al liberar no tapa el error del trabajo", async () => {
    const { a, collection } = harness();
    collection.deleteOne.mockRejectedValueOnce(new Error("sin conexión"));

    await expect(
      a.within("catalog", TTL, async () => {
        throw new Error("el catálogo explotó");
      }),
    ).rejects.toThrow("el catálogo explotó");
  });

  // EL DUEÑO ES POR PROCESO Y NO POR LLAMADA, y esto es la consecuencia, medida y no argumentada:
  // el mismo proceso vuelve a entrar sobre su propio lease. Es deliberado —un `release` que no
  // llegó a la base no puede dejar al proceso esperando su propio vencimiento— y tiene un precio
  // que hay que conocer: el `within` de adentro LIBERA al salir, así que el de afuera sigue
  // corriendo sin lease. Este lease excluye PROCESOS, no llamadas concurrentes del mismo proceso.
  it("el mismo dueño reentra sobre su propio lease, y el interno lo libera al salir", async () => {
    const { a, c } = harness();
    const held = blockingWork("afuera");

    const outer = a.within("catalog", TTL, async () => {
      const inner = await a.within("catalog", TTL, async () => "adentro");
      expect(inner).toBe("adentro");
      return held.work();
    });
    await held.entered;

    await expect(c.within("catalog", TTL, async () => "trabajo-de-c")).resolves.toBe(
      "trabajo-de-c",
    );

    held.release();
    await expect(outer).resolves.toBe("afuera");
  });
});

describe("MongoLease: el cable con la base", () => {
  it("adquiere con una sola operación atómica sobre la colección de leases", async () => {
    const { a, collection, collectionOf } = harness();

    await a.within("catalog", TTL, async () => "listo");

    expect(LEASE_COLLECTION).toBe("game_mode_leases");
    expect(collectionOf).toHaveBeenCalledWith(LEASE_COLLECTION);
    expect(collection.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = collection.findOneAndUpdate.mock.calls[0] ?? [];
    expect(filter).toEqual({
      _id: "catalog",
      $or: [{ until: { $lte: new Date(BASE_INSTANT) } }, { owner: expect.any(String) }],
    });
    expect(update?.$set).toEqual({
      owner: expect.any(String),
      until: new Date(BASE_INSTANT + TTL),
    });
    // `toEqual` y no `toMatchObject`: `upsert` es lo único que se manda, y lo que se mide es que no
    // sobre nada. Un `returnDocument: "after"` agregado "por las dudas" es configuración muerta —el
    // documento devuelto no se lee nunca, porque lo que decide la adquisición es que no haya
    // lanzado— y con `toMatchObject` entraría sin ponerse rojo.
    expect(options).toEqual({ upsert: true });
  });

  // EL DUPLICADO SE RECONOCE POR EL CÓDIGO NUMÉRICO, no por el texto del mensaje: el mensaje trae
  // el nombre del índice, el namespace y la clave, y cambia entre versiones del servidor. Un
  // `/E11000/.test(message)` sobreviviría a este test y se rompería en producción el día que Mongo
  // reescriba la frase.
  it("un E11000 con cualquier mensaje es 'no adquirido'", async () => {
    const { a, collection } = harness();
    collection.findOneAndUpdate.mockRejectedValueOnce(
      Object.assign(new Error("clave repetida"), { code: 11000 }),
    );

    await expect(a.within("catalog", TTL, async () => "listo")).resolves.toBeUndefined();
  });

  // Y CUALQUIER OTRO FALLO SUBE. Tratar todo error de la base como "ocupado" convertiría un Mongo
  // caído en un 503 de "catálogo ocupado" eterno, que manda al operador a buscar el proceso que
  // tiene el lease en vez de la base que no contesta.
  it("un fallo de la base que no es duplicado sube", async () => {
    const { a, collection } = harness();
    collection.findOneAndUpdate.mockRejectedValueOnce(new Error("sin conexión"));

    await expect(a.within("catalog", TTL, async () => "listo")).rejects.toThrow("sin conexión");
  });
});

// EL LEASE DE LA INSTANCIA QUE NO TIENE MONGO. No es un doble de test: es lo que el proceso sin
// `MONGO_URI` despliega, igual que `MemoryHistory` y `MemoryGameModeRepository`.
describe("MemoryLease", () => {
  it("corre el trabajo y devuelve su resultado", async () => {
    await expect(new MemoryLease().within("catalog", TTL, async () => "listo")).resolves.toBe(
      "listo",
    );
  });

  it("el error del trabajo sube igual que en Mongo", async () => {
    await expect(
      new MemoryLease().within("catalog", TTL, async () => {
        throw new Error("el catálogo explotó");
      }),
    ).rejects.toThrow("el catálogo explotó");
  });

  // NUNCA DEVUELVE `undefined`, y eso no es una simplificación: es la misma semántica que el
  // adaptador Mongo tiene para un dueño solo. El lease excluye PROCESOS, y un proceso sin Mongo no
  // comparte estado con ninguno — no hay a quién excluir. Guardar un `Map` de leases acá simularía
  // una negación que ni siquiera el adaptador real produce contra sí mismo.
  it("nunca niega el lease: un proceso solo no tiene a quién excluir", async () => {
    const lease = new MemoryLease();
    const held = blockingWork("primero");

    const first = lease.within("catalog", TTL, held.work);
    await held.entered;

    await expect(lease.within("catalog", TTL, async () => "segundo")).resolves.toBe("segundo");

    held.release();
    await expect(first).resolves.toBe("primero");
  });
});
