import { Mongo } from "@/shared/mongo";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GAME_MODE_COLLECTION,
  MongoGameModeRepository,
  subscribeExistingModes,
} from "./mongo-repository";
import {
  BASE_INSTANT,
  clasica,
  describeGameModeRepositoryContract,
  mutableClock,
} from "./tests/repository-contract";

// EL CONTRATO CONTRA UN MONGO DE VERDAD. El de `mongo-repository.test.ts` corre contra un doble del
// driver, y para los operadores nuevos eso no alcanza: lo que tiene que estar bien es cómo MONGO lee
// un `ownerProviderId: null` contra el campo ausente, qué hace `$addToSet` sobre un campo que no está
// y que el upsert con `$setOnInsert` no pise lo que había. El doble los imita; esto los mide.
//
// ⚠ PIDE UN MONGO DE VERDAD: lee `MONGO_INT_URI` y se saltea sin ella (`src/tests/int-services.ts`).
// Usa la colección productiva por nombre —el adaptador no deja elegir otra— en la base de la URI,
// que tiene que ser una de pruebas.
describe.skipIf(!MONGO_INT_URI)("MongoGameModeRepository contra Mongo", () => {
  let mongo: Mongo;

  const collection = async () => await mongo.collection(GAME_MODE_COLLECTION);

  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  afterAll(async () => {
    await (await collection()).drop().catch(() => {});
    await mongo.close();
  });

  beforeEach(async () => {
    await (await collection()).deleteMany({});
  });

  describeGameModeRepositoryContract("MongoGameModeRepository (Mongo real)", () => {
    const clock = mutableClock();
    return { repository: new MongoGameModeRepository(mongo, clock), clock };
  });

  // EL DOCUMENTO DE v1: sin `ownerProviderId` ni `subscribers`. Escrito con el driver y no
  // con el adaptador, que ya no sabe crear uno.
  async function legacyMode(uuid = "11111111-2222-4333-8444-555555555555") {
    await (await collection()).insertOne({
      uuid,
      name: "Clásica v1",
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
    return uuid;
  }

  it("un documento de v1 se lee como compartido sin nadie, y suscribirse le crea la lista", async () => {
    const repository = new MongoGameModeRepository(mongo, mutableClock());
    const uuid = await legacyMode();

    expect(await repository.byUuid(uuid)).toMatchObject({ ownerProviderId: null, subscribers: [] });
    expect(await repository.removeSubscriber(uuid, "parley")).toMatchObject({ subscribers: [] });
    expect(await repository.addSubscriber(uuid, "parley")).toMatchObject({
      subscribers: ["parley"],
      version: 0,
      updatedAt: new Date(BASE_INSTANT),
    });
  });

  // LA SUSCRIPCIÓN DE UNA SOLA VEZ: sólo los compartidos SIN el campo, así que la segunda corrida no
  // toca nada —tampoco lo que un operador cambió entre las dos—, y un compartido nuevo (con `[]`
  // escrito) o un propio quedan como están.
  it("subscribeExistingModes suscribe sólo los compartidos sin lista, y es idempotente", async () => {
    const repository = new MongoGameModeRepository(mongo, mutableClock());
    const viejo = await legacyMode();
    const otroViejo = await legacyMode("22222222-2222-4333-8444-555555555555");
    const nuevo = await repository.create(clasica({ name: "Nuevo" }));
    const propio = await repository.create(clasica({ name: "Propio", ownerProviderId: "parley" }));

    expect(await subscribeExistingModes(mongo, ["betaso", "parley", "betaso"])).toBe(2);
    expect((await repository.byUuid(viejo))?.subscribers).toEqual(["betaso", "parley"]);
    expect((await repository.byUuid(otroViejo))?.subscribers).toEqual(["betaso", "parley"]);
    expect((await repository.byUuid(nuevo.uuid))?.subscribers).toEqual([]);
    expect((await repository.byUuid(propio.uuid))?.subscribers).toEqual([]);
    expect((await repository.byUuid(viejo))?.version).toBe(0);

    await repository.removeSubscriber(viejo, "parley");
    expect(await subscribeExistingModes(mongo, ["betaso", "parley"])).toBe(0);
    expect((await repository.byUuid(viejo))?.subscribers).toEqual(["betaso"]);
  });

  // DOS INSTANCIAS COPIANDO LO MISMO A LA VEZ: el lease lo evita, pero si fallara, el índice único
  // de `uuid` deja una sola copia y la otra la lee.
  it("dos insertIfAbsent concurrentes con el mismo uuid dejan un documento", async () => {
    const repository = new MongoGameModeRepository(mongo, mutableClock());
    const uuid = "bb041643-c230-559e-9082-526e5f05487b";
    const input = clasica({ name: "Copia", ownerProviderId: "parley" });

    const results = await Promise.all([
      repository.insertIfAbsent(uuid, input),
      repository.insertIfAbsent(uuid, input),
      repository.insertIfAbsent(uuid, input),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await (await collection()).countDocuments({ uuid })).toBe(1);
  });
});
