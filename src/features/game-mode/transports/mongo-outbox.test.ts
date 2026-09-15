import type { Collection, Filter, IndexDescription, UpdateFilter } from "mongodb";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  GAME_MODE_OUTBOX_COLLECTION,
  type GameModeOutboxDocument,
  MongoGameModeOutbox,
} from "./mongo-outbox.js";
import type { CollectionSource } from "./mongo-repository.js";
import { clasica, describeGameModeOutboxContract } from "./tests/outbox-contract.js";
import { BASE_INSTANT, mutableClock } from "./tests/repository-contract.js";

// CONTRA UN DOBLE DEL DRIVER, y no contra un Mongo de verdad, por la misma razón que
// `mongo-repository.test.ts`: `vitest.setup.ts` BORRA `MONGO_URI` a propósito y la suite no depende de
// ningún servicio externo.
//
// ESTE DOBLE HACE CUMPLIR LOS ÍNDICES ÚNICOS QUE EL ADAPTADOR DECLARA, y esa es la línea que decide si
// el archivo mide algo. La idempotencia del outbox NO es una consulta previa: es un `insertOne` que
// choca contra `{dedupeKey:1} unique` y se traga el E11000. Un doble que deduplicara por su cuenta
// dejaría pasar verde a un adaptador que declara el índice sin `unique`, que es exactamente el evento
// publicado dos veces en producción.

type StoredDocument = GameModeOutboxDocument & { _id: ObjectId };

const DUPLICATE_KEY = 11000;

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected);
  if (typeof expected === "object" && expected !== null && "$in" in expected) {
    return (expected as { $in: readonly unknown[] }).$in.includes(actual);
  }
  return actual === expected;
}

function matches(document: StoredDocument, filter: Filter<GameModeOutboxDocument>): boolean {
  return Object.entries(filter).every(([key, value]) =>
    matchesValue((document as unknown as Record<string, unknown>)[key], value),
  );
}

// El orden es por `_id` y el `_id` es un `ObjectId`: su hex es monótono dentro de un proceso
// (timestamp + contador), así que comparar el hex es comparar el orden de inserción — que es lo que
// el adaptador le pide a la base.
function byId(left: StoredDocument, right: StoredDocument): number {
  return left._id.toHexString().localeCompare(right._id.toHexString());
}

function fakeCollection() {
  const documents: StoredDocument[] = [];
  let uniqueKeys: string[] = [];
  const createIndexes = vi.fn(async (specs: IndexDescription[]) => {
    uniqueKeys = specs
      .filter((spec) => spec.unique === true)
      .flatMap((spec) => Object.keys(spec.key));
    return [];
  });

  const collection = {
    createIndexes,
    insertOne: vi.fn(async (document: GameModeOutboxDocument) => {
      for (const key of uniqueKeys) {
        const value = (document as unknown as Record<string, unknown>)[key];
        if (documents.some((stored) => matchesValue(stored[key as never], value))) {
          throw Object.assign(new Error("E11000 duplicate key error"), { code: DUPLICATE_KEY });
        }
      }
      const _id = new ObjectId();
      documents.push({ ...document, _id });
      return { acknowledged: true, insertedId: _id };
    }),
    findOne: vi.fn(
      async (
        filter: Filter<GameModeOutboxDocument>,
        options?: { sort?: Record<string, 1 | -1> },
      ) => {
        const found = documents.filter((document) => matches(document, filter));
        if (options?.sort) found.sort(byId);
        return found[0] ?? null;
      },
    ),
    find: vi.fn((filter: Filter<GameModeOutboxDocument>) => ({
      toArray: async () => documents.filter((document) => matches(document, filter)),
    })),
    updateOne: vi.fn(
      async (
        filter: Filter<GameModeOutboxDocument>,
        update: UpdateFilter<GameModeOutboxDocument>,
      ) => {
        const index = documents.findIndex((document) => matches(document, filter));
        if (index < 0) return { acknowledged: true, matchedCount: 0 };
        const after = { ...(documents[index] as StoredDocument), ...(update.$set ?? {}) };
        for (const [key, delta] of Object.entries(update.$inc ?? {})) {
          const target = after as unknown as Record<string, number>;
          target[key] = (target[key] ?? 0) + Number(delta);
        }
        documents[index] = after as StoredDocument;
        return { acknowledged: true, matchedCount: 1 };
      },
    ),
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
  const fake = fakeCollection();
  return { outbox: new MongoGameModeOutbox(fake.source, clock), clock, ...fake };
}

describeGameModeOutboxContract("MongoGameModeOutbox", harness);

// LO QUE SÓLO EL ADAPTADOR MONGO PUEDE TENER: el nombre de la colección, los dos índices, la forma del
// documento y el hex del `ObjectId`. El contrato mide el puerto; esto mide el cable, y es lo que
// decide si un operador puede auditar el outbox con `mongosh` cuando un evento no llegó.
describe("MongoGameModeOutbox: el documento durable", () => {
  it("escribe y lee siempre de la colección del outbox", async () => {
    const { outbox, collectionOf } = harness();

    await outbox.next(new Date(BASE_INSTANT));

    expect(GAME_MODE_OUTBOX_COLLECTION).toBe("game_mode_outbox");
    expect(collectionOf).toHaveBeenCalledWith(GAME_MODE_OUTBOX_COLLECTION);
  });

  // DOS ÍNDICES Y NINGÚN TTL. El único es la idempotencia —lo que impide el evento repetido— y el
  // compuesto es la consulta de `next()`, que corre una vez por segundo para siempre. Un TTL sería
  // borrar los `SENT`, y los `SENT` son justamente lo que hace que la reconciliación no vuelva a
  // emitir toda revisión ya publicada en cada tick.
  it("declara el índice único de deduplicación y el de la cola", async () => {
    const { outbox, collection } = harness();

    await outbox.next(new Date(BASE_INSTANT));

    expect(collection.createIndexes).toHaveBeenCalledTimes(1);
    expect(collection.createIndexes.mock.calls[0]?.[0]).toEqual([
      { key: { dedupeKey: 1 }, name: "dedupeKey_1", unique: true },
      { key: { status: 1, _id: 1 }, name: "status_1__id_1" },
    ]);
  });

  it("inserta el documento entero, pendiente, sin intentos y sin _id", async () => {
    const { outbox, collection } = harness();

    await outbox.enqueueCreated(clasica());

    expect(collection.insertOne).toHaveBeenCalledTimes(1);
    const inserted = collection.insertOne.mock.calls[0]?.[0];
    // `toEqual` y no `toMatchObject`: lo que se mide es que no sobre NI FALTE nada. `sentAt` y
    // `lastError` no se escriben al nacer —un `undefined` explícito es un `null` en la base— y un
    // campo de más acá es un campo que el operador va a interpretar al auditar.
    expect(inserted).toEqual({
      dedupeKey: '["game_mode.created","mode-1"]',
      routingKey: "game_mode.created",
      payload: {
        id: "mode-1",
        game: "domino",
        name: "Clásica",
        isActive: true,
        prize: 18,
        entryFee: 10,
        multiplier: 2,
        pointsToWin: 25,
        playerCount: 2,
      },
      status: "PENDING",
      attempts: 0,
      createdAt: new Date(BASE_INSTANT),
      nextAttemptAt: new Date(BASE_INSTANT),
    });
    expect(inserted).not.toHaveProperty("_id");
  });

  // EL `id` DEL PUERTO ES EL HEX DEL `_id`, y es lo que el dispatcher le devuelve a `sent`/`retry`.
  // Un id inventado por el proceso dejaría a esas dos escrituras sin a quién apuntar.
  it("el id del puerto es el hex del _id que asignó Mongo", async () => {
    const { outbox, documents } = harness();
    await outbox.enqueueCreated(clasica());

    const entry = await outbox.next(new Date(BASE_INSTANT));

    expect(entry?.id).toBe(documents[0]?._id.toHexString());
    expect(entry?.id).toMatch(/^[0-9a-f]{24}$/);
  });

  // LA COLA SE CONSULTA POR `status` Y SE ORDENA POR `_id`, que es el índice compuesto declarado
  // arriba. Ordenar por `createdAt` colapsaría dos encolados del mismo milisegundo —y el reloj del
  // repositorio es inyectado justamente porque eso pasa—; el `_id` es el orden de inserción.
  it("la cola pide el pendiente más viejo por _id", async () => {
    const { outbox, collection } = harness();
    await outbox.enqueueCreated(clasica());

    await outbox.next(new Date(BASE_INSTANT));

    const [filter, options] = collection.findOne.mock.calls.at(-1) ?? [];
    expect(filter).toEqual({ status: "PENDING" });
    expect(options).toMatchObject({ sort: { _id: 1 } });
  });

  it("marcar entregado escribe el estado y el instante del confirm", async () => {
    const { outbox, collection, documents } = harness();
    await outbox.enqueueCreated(clasica());
    const entry = await outbox.next(new Date(BASE_INSTANT));

    await outbox.sent(entry?.id ?? "", new Date(BASE_INSTANT + 25));

    const [filter, update] = collection.updateOne.mock.calls.at(-1) ?? [];
    expect(filter).toEqual({ _id: new ObjectId(entry?.id) });
    expect(update?.$set).toEqual({ status: "SENT", sentAt: new Date(BASE_INSTANT + 25) });
    expect(documents[0]).toMatchObject({ status: "SENT", sentAt: new Date(BASE_INSTANT + 25) });
  });

  // LOS INTENTOS SON UN `$inc` DE LA BASE, no un número calculado en el proceso: el dispatcher lee
  // la entrada, publica, falla y escribe — y entre la lectura y la escritura otro proceso pudo tomar
  // el lease vencido y fallar también. Con `leído + 1` los dos escriben el mismo número y el backoff
  // se queda clavado en el primer escalón.
  it("reintentar incrementa los intentos en la base y agenda el próximo", async () => {
    const { outbox, collection, documents } = harness();
    await outbox.enqueueCreated(clasica());
    const entry = await outbox.next(new Date(BASE_INSTANT));

    await outbox.retry(entry?.id ?? "", "sin confirmar", new Date(BASE_INSTANT + 1_000));

    const [, update] = collection.updateOne.mock.calls.at(-1) ?? [];
    expect(update?.$inc).toEqual({ attempts: 1 });
    expect(update?.$set).toEqual({
      nextAttemptAt: new Date(BASE_INSTANT + 1_000),
      lastError: "sin confirmar",
    });
    // NO vuelve a `PENDING` ni toca `status`: nunca dejó de estarlo. Escribirlo igual sugeriría que
    // existe un estado intermedio "en vuelo" que este outbox no tiene — y no lo tiene a propósito:
    // un evento tomado por un proceso que muere tiene que volver a salir solo cuando venza el lease.
    expect(documents[0]).toMatchObject({ status: "PENDING", attempts: 1 });
  });

  // LA IDEMPOTENCIA LA IMPONE LA BASE Y NO UNA CONSULTA PREVIA. Entre un `findOne` que no encuentra
  // nada y el `insertOne` que sigue hay un turno del event loop, y dos procesos que lo aprovechen
  // insertan los dos. El E11000 es el camino ORDINARIO de "ya estaba", y se reconoce por el CÓDIGO
  // numérico: una expresión regular sobre el mensaje pasa la suite y se rompe el día que el servidor
  // reescriba la frase.
  it("el duplicado lo rechaza el índice único y el adaptador lo da por hecho", async () => {
    const { outbox, collection, documents } = harness();

    await outbox.enqueueCreated(clasica());
    await outbox.enqueueCreated(clasica());

    expect(collection.insertOne).toHaveBeenCalledTimes(2);
    expect(documents).toHaveLength(1);
  });

  // CUALQUIER OTRO FALLO SUBE. Tragarse todo error de escritura convertiría un Mongo caído en un
  // outbox que acepta eventos y no guarda ninguno — o sea el catálogo desincronizado en silencio,
  // que es exactamente lo que este archivo existe para impedir.
  it("un fallo que no es duplicado sube al llamador", async () => {
    const { outbox, collection } = harness();
    collection.insertOne.mockRejectedValueOnce(new Error("sin conexión"));

    await expect(outbox.enqueueCreated(clasica())).rejects.toThrow("sin conexión");
  });

  // LA RECONCILIACIÓN PREGUNTA POR LAS CLAVES CANDIDATAS, no lee la colección entera: son dos claves
  // por modo resueltas contra el índice único. Ver el techo escrito en `mongo-outbox.ts`.
  it("la reconciliación consulta sólo las claves de los modos que recibió", async () => {
    const { outbox, collection } = harness();

    await outbox.reconcile([clasica({ version: 2 })]);

    expect(collection.find).toHaveBeenCalledTimes(1);
    expect(collection.find.mock.calls[0]?.[0]).toEqual({
      dedupeKey: {
        $in: ['["game_mode.created","mode-1"]', '["game_mode.updated","mode-1",2]'],
      },
    });
  });

  it("un catálogo vacío no consulta la colección", async () => {
    const { outbox, collection } = harness();

    await outbox.reconcile([]);

    expect(collection.find).not.toHaveBeenCalled();
  });

  it("los índices se crean una sola vez para todas las operaciones", async () => {
    const { outbox, collection } = harness();

    await outbox.enqueueCreated(clasica());
    await outbox.ensureUpdated(clasica({ version: 1 }));
    await outbox.sync([clasica()], "batch-1");
    await outbox.reconcile([clasica()]);
    await outbox.next(new Date(BASE_INSTANT));

    expect(collection.createIndexes).toHaveBeenCalledTimes(1);
  });

  // Un fallo al preparar la colección NO puede dejar al adaptador pegado a una promesa rechazada para
  // siempre: es la misma decisión que el `finally` de `Mongo.ready()` y que el repositorio. Con el
  // memo sin limpiar, un Mongo que tardó en levantar deja el outbox muerto hasta que alguien reinicie
  // el proceso — y el outbox muerto es el catálogo que nunca se publica.
  it("un fallo preparando la colección se puede reintentar", async () => {
    const { outbox, collectionOf } = harness();
    collectionOf.mockRejectedValueOnce(new Error("sin conexión"));

    await expect(outbox.next(new Date(BASE_INSTANT))).rejects.toThrow("sin conexión");
    await expect(outbox.next(new Date(BASE_INSTANT))).resolves.toBeUndefined();
  });
});
