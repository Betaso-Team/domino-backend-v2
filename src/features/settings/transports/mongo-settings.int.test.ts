import { Mongo } from "@/shared/mongo";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoSettings } from "./mongo-settings";

// UN TEST DE CONTRATO contra un Mongo DE VERDAD, porque lo que tiene que estar bien no es la mezcla
// —ésa es de la señal— sino que la escritura sea un PARCHE y que pase al lado del documento de v1 sin
// tocarlo. Ninguna de las dos cosas se ve con un driver de mentira.
const COLLECTION = "test_domino_v2_settings";

// El singleton de v1 como lo declara su schema: la clave propia, el interruptor y sus tres plazos.
const V1 = {
  id: "domino_settings",
  isUnderMaintenance: false,
  playerTurnTimeout: 60,
  playerExtraTimeout: 30,
  matchmakingTimeout: 120,
};

// ⚠ PIDE UN MONGO DE VERDAD: lee `MONGO_INT_URI` y se saltea sin ella (`src/tests/int-services.ts`).
describe.skipIf(!MONGO_INT_URI)("MongoSettings (el parche y la convivencia con v1)", () => {
  let mongo: Mongo;
  let settings: MongoSettings;

  const documents = async () => await (await mongo.collection(COLLECTION)).find({}).toArray();

  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
    settings = new MongoSettings(mongo, COLLECTION, new MemoryLogger());
  });

  afterAll(async () => {
    await (await mongo.collection(COLLECTION)).drop().catch(() => {});
    await mongo.close();
  });

  beforeEach(async () => {
    await (await mongo.collection(COLLECTION)).deleteMany({});
  });

  it("sin documento no hay overrides, que no es lo mismo que no poder leer", async () => {
    expect(await settings.current()).toEqual({});
  });

  it("el primer parche crea el documento y lo marca como nuestro", async () => {
    await settings.save("match", { presentingRoundMs: 6000 });

    const [document] = await documents();
    expect(document).toMatchObject({ id: "domino_v2_runtime_config", version: 2 });
    expect(await settings.current()).toEqual({ match: { presentingRoundMs: 6000 } });
  });

  it("un segundo parche NO pisa el campo que no vino", async () => {
    await settings.save("match", { presentingRoundMs: 6000 });

    await settings.save("match", { turnTimeoutMs: 45_000 });

    expect(await settings.current()).toEqual({
      match: { presentingRoundMs: 6000, turnTimeoutMs: 45_000 },
    });
  });

  it("cada sección vive por su cuenta", async () => {
    await settings.save("match", { presentingRoundMs: 6000 });
    await settings.save("matchmaking", { searchTimeoutMs: 90_000 });

    await settings.clear("match");

    expect(await settings.current()).toEqual({ matchmaking: { searchTimeoutMs: 90_000 } });
  });

  // LA QUE IMPORTA el día que alguien mueva esto: el interruptor de mantenimiento se lee de un
  // documento de esta misma colección.
  it("el documento de v1 queda intacto después de escribir el nuestro", async () => {
    await (await mongo.collection(COLLECTION)).insertOne({ ...V1 });

    await settings.save("match", { presentingRoundMs: 6000 });
    await settings.clear("match");

    const theirs = await (await mongo.collection(COLLECTION)).findOne({ id: V1.id });
    expect(theirs).toMatchObject(V1);
    expect(theirs).not.toHaveProperty("sections");
    expect(await documents()).toHaveLength(2);
  });
});
