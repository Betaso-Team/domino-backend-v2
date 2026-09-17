import type { Collection, Filter, IndexDescription, UpdateFilter } from "mongodb";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import {
  type CollectionSource,
  GAME_MODE_COLLECTION,
  type GameModeDocument,
  MongoGameModeRepository,
} from "./mongo-repository.js";
import {
  BASE_INSTANT,
  clasica,
  describeGameModeRepositoryContract,
  mutableClock,
} from "./tests/repository-contract.test.js";

// CONTRA UN DOBLE DEL DRIVER, y no contra un Mongo de verdad, por la misma razón que
// `mongo-history.test.ts`: `vitest.setup.ts` BORRA `MONGO_URI` a propósito, así que la suite no
// depende de ningún servicio externo y esa es una propiedad del repo y no del shell de quien la
// corre. Un test de contra-base que sólo corre en la máquina con Mongo levantado es un test que
// nadie ve fallar.
//
// La diferencia con el doble del historial es que ÉSTE TIENE COMPORTAMIENTO. Allá lo que se mide
// son los argumentos —que sea `$push` y no `$set`—; acá la mitad del contrato es el RESULTADO: el
// orden de `active()`, que un campo omitido siga en su lugar, que la revisión avance. Un doble que
// sólo grabara llamadas dejaría que "ordena" se pruebe afirmando que se pidió un sort, que es medir
// el argumento y no el efecto — y un sort pedido sobre el campo equivocado pasaría verde.
//
// Lo que este doble NO puede probar es que Mongo acepte el documento; eso lo cubre `tsc`, que es el
// gate de este repo: el update va tipado como `UpdateFilter<GameModeDocument>` del propio driver.

type StoredDocument = GameModeDocument & { _id: ObjectId };

// El subconjunto de filtros que este adaptador usa: igualdad sobre campos de primer nivel
// (`{ uuid }`, `{ isActive: true }`, `{ uuid, isActive: true }`). No se implementa más porque no se
// usa más — un doble con operadores que nadie llama es código que puede estar mal sin que nada lo
// note.
function matches(document: StoredDocument, filter: Filter<GameModeDocument>): boolean {
  return Object.entries(filter).every(
    ([key, value]) => (document as unknown as Record<string, unknown>)[key] === value,
  );
}

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : Number(left);
  const b = right instanceof Date ? right.getTime() : Number(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function fakeCollection() {
  const documents: StoredDocument[] = [];
  const createIndexes = vi.fn(async (_specs: IndexDescription[]) => []);

  // El cursor tiene `toArray` **y** `sort`, y eso es deliberado: si sólo tuviera `sort`, un
  // adaptador que se olvidara de ordenar explotaría en vez de devolver el orden equivocado, y el
  // test estaría midiendo que el método existe. Así, quitar el `.sort()` devuelve el orden de
  // inserción y el contrato se pone rojo por el motivo correcto.
  const cursorOf = (found: StoredDocument[]) => ({
    toArray: async () => [...found],
    sort: (spec: Record<string, 1 | -1>) =>
      cursorOf(
        [...found].sort((left, right) => {
          for (const [key, direction] of Object.entries(spec)) {
            const order = compare(
              (left as unknown as Record<string, unknown>)[key],
              (right as unknown as Record<string, unknown>)[key],
            );
            if (order !== 0) return order * direction;
          }
          return 0;
        }),
      ),
  });

  const collection = {
    createIndexes,
    insertOne: vi.fn(async (document: GameModeDocument) => {
      const _id = new ObjectId();
      // Se guarda una COPIA: el driver real no comparte el objeto que le pasaron, y compartirlo
      // dejaría que una mutación posterior del adaptador se reflejara sola en "la base".
      documents.push({ ...document, _id });
      return { acknowledged: true, insertedId: _id };
    }),
    findOne: vi.fn(async (filter: Filter<GameModeDocument>) => {
      return documents.find((document) => matches(document, filter)) ?? null;
    }),
    find: vi.fn((filter: Filter<GameModeDocument>) =>
      cursorOf(documents.filter((document) => matches(document, filter))),
    ),
    findOneAndUpdate: vi.fn(
      async (
        filter: Filter<GameModeDocument>,
        update: UpdateFilter<GameModeDocument>,
        options?: { returnDocument?: "after" | "before" },
      ) => {
        const index = documents.findIndex((document) => matches(document, filter));
        if (index < 0) return null;
        const before = documents[index] as StoredDocument;
        const after = { ...before, ...(update.$set ?? {}) } as StoredDocument;
        for (const [key, delta] of Object.entries(update.$inc ?? {})) {
          const target = after as unknown as Record<string, number>;
          target[key] = (target[key] ?? 0) + Number(delta);
        }
        documents[index] = after;
        // `before` cuando no se pidió `after`, que es el default REAL del driver. Es lo que hace
        // que olvidarse de `{ returnDocument: "after" }` devuelva la revisión anterior y el
        // contrato se ponga rojo.
        return options?.returnDocument === "after" ? after : before;
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
  return { repository: new MongoGameModeRepository(fake.source, clock), clock, ...fake };
}

describeGameModeRepositoryContract("MongoGameModeRepository", harness);

// LO QUE SÓLO EL ADAPTADOR MONGO PUEDE TENER, y lo que de verdad decide si el corte a v2 es
// compatible: la forma exacta del documento, los cuatro índices y el nombre de la colección. Un
// campo que este adaptador se olvide de escribir es un campo que los lectores de v1 dejan de
// encontrar, y ninguna aserción sobre la entidad lo ve — la entidad se construye del mismo lado.
describe("MongoGameModeRepository: el documento productivo", () => {
  it("inserta exactamente los campos del schema de v1, con __v en cero y sin _id", async () => {
    const { repository, collection } = harness();

    await repository.create(clasica());

    expect(collection.insertOne).toHaveBeenCalledTimes(1);
    const inserted = collection.insertOne.mock.calls[0]?.[0];
    // `toEqual` y no `toMatchObject`: lo que se mide es que no sobre NI FALTE nada. `createdBy` y
    // `updatedBy` son el caso concreto — el servicio de v1 se los pasaba a Mongoose
    // (`game-mode.service.ts:67` y `:112`) y el schema los descartaba por `strict`, así que no
    // forman parte del documento productivo y agregarlos acá inventaría un campo.
    expect(inserted).toEqual({
      uuid: expect.any(String),
      name: "Clásica",
      multiplier: 1,
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
      pointsToWin: 25,
      isActive: true,
      isFreeRoom: false,
      enableBots: false,
      createdAt: new Date(BASE_INSTANT),
      updatedAt: new Date(BASE_INSTANT),
      __v: 0,
    });
    // El `_id` NO se manda: lo asigna Mongo y el adaptador lo recibe en `insertedId`. Generarlo
    // acá funcionaría, pero dejaría al proceso decidiendo una identidad que la base ya decide.
    expect(inserted).not.toHaveProperty("_id");
  });

  // `id` es el HEX DEL `_id`, y no el uuid. Es identidad de almacenamiento: el DTO HTTP tiene que
  // devolver `_id` porque el panel de v1 lo recibía. El identificador LÓGICO es el otro.
  it("el id de la entidad es el hex del _id que asignó Mongo", async () => {
    const { repository, documents } = harness();

    const created = await repository.create(clasica());

    expect(created.id).toBe(documents[0]?._id.toHexString());
    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
    expect(created.uuid).not.toBe(created.id);
  });

  it("escribe y lee siempre de la colección productiva", async () => {
    const { repository, collectionOf } = harness();

    await repository.all();

    expect(GAME_MODE_COLLECTION).toBe("game_modes_domino");
    expect(collectionOf).toHaveBeenCalledWith(GAME_MODE_COLLECTION);
  });

  // LOS CUATRO ÍNDICES DE v1, con sus nombres. Los nombres se escriben y no se dejan derivar
  // porque el índice ya existe en producción con ese nombre: `createIndexes` es idempotente
  // mientras nombre y clave coincidan, y un nombre distinto sobre la misma clave crea un índice
  // DUPLICADO en vez de reconocer el que está.
  //
  // Los cuatro salen del schema de v1: `uuid` con `unique: true, index: true` y `isActive` con
  // `index: true` (`game-mode.schema.ts:20-25` y `:57-61`), más los dos compuestos declarados
  // aparte (`game-mode.schema.ts:78-79`).
  it("declara los cuatro índices de v1 con sus nombres", async () => {
    const { repository, collection } = harness();

    await repository.all();

    expect(collection.createIndexes).toHaveBeenCalledTimes(1);
    expect(collection.createIndexes.mock.calls[0]?.[0]).toEqual([
      { key: { uuid: 1 }, name: "uuid_1", unique: true },
      { key: { isActive: 1 }, name: "isActive_1" },
      { key: { isActive: 1, name: 1 }, name: "isActive_1_name_1" },
      { key: { isActive: 1, uuid: 1 }, name: "isActive_1_uuid_1" },
    ]);
  });

  // MEMOIZADO: crear índices es una operación de arranque, no de consulta. Sin el memo, cada lectura
  // del catálogo —que es el camino del lobby— pagaría un round-trip extra contra la base para
  // recrear cuatro índices que ya están.
  it("los índices se crean una sola vez para todas las operaciones", async () => {
    const { repository, collection } = harness();

    const created = await repository.create(clasica());
    await repository.all();
    await repository.active();
    await repository.byUuid(created.uuid);
    await repository.activeByUuid(created.uuid);
    await repository.update(created.uuid, { prize: 20 });

    expect(collection.createIndexes).toHaveBeenCalledTimes(1);
  });

  // Un fallo al preparar la colección NO puede dejar al adaptador pegado a una promesa rechazada
  // para siempre: es la misma decisión que el `finally` de `Mongo.ready()`. Con el memo sin
  // limpiar, un Mongo que tardó en levantar deja el catálogo muerto hasta que alguien reinicie el
  // proceso.
  it("un fallo preparando la colección se puede reintentar", async () => {
    const { repository, collectionOf } = harness();
    collectionOf.mockRejectedValueOnce(new Error("sin conexión"));

    await expect(repository.all()).rejects.toThrow("sin conexión");
    await expect(repository.all()).resolves.toEqual([]);
  });
});

describe("MongoGameModeRepository: la edición en la base", () => {
  // La aserción de COMPORTAMIENTO ("los campos omitidos quedan como estaban") vive en el contrato;
  // ésta mide el CABLE, que es donde se rompe distinto: `$set: { name: undefined }` no es un campo
  // omitido para el driver, es un `null` escrito encima. El documento de update tiene que traer
  // sólo las claves que el llamador mandó.
  it("el $set lleva sólo los campos mandados, y nunca un undefined", async () => {
    const { repository, collection } = harness();
    const created = await repository.create(clasica());

    await repository.update(created.uuid, { name: "Renombrada", isActive: false });

    const [filter, update, options] = collection.findOneAndUpdate.mock.calls[0] ?? [];
    expect(filter).toEqual({ uuid: created.uuid });
    expect(update?.$set).toEqual({
      name: "Renombrada",
      isActive: false,
      updatedAt: new Date(BASE_INSTANT),
    });
    // LA REVISIÓN ES UN `$inc` DE LA BASE, no un número calculado en el proceso: dos ediciones que
    // leyeran el `__v` viejo y escribieran `viejo + 1` producirían la misma revisión.
    expect(update?.$inc).toEqual({ __v: 1 });
    expect(options).toMatchObject({ returnDocument: "after" });
  });
});
