import { Mongo } from "@/shared/mongo";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HISTORY_COLLECTION, MongoHistory } from "./mongo-history";
import { SETUP, describeHistoryContract, entry } from "./tests/history-contract";

// EL CONTRATO CONTRA UN MONGO DE VERDAD, y es el único lugar donde se puede medir: la cabecera y el
// cierre van por pipeline (`$replaceWith`), y lo que hay que ver —que el primero gane, que lo cerrado
// no se reabra, que los arreglos queden al final, que un campo ausente no nazca vacío— es semántica
// de la base, que un doble del driver repetiría en vez de medir.
//
// ⚠ PIDE UN MONGO DE VERDAD: lee `MONGO_INT_URI` y se saltea sin ella (`src/tests/int-services.ts`).
// La colección no es configurable (`HISTORY_COLLECTION`), así que el aislamiento es la BASE de la URI:
// apuntala a una base de prueba, nunca a la de una instancia.
let mongo: Mongo;

const collection = () => mongo.collection(HISTORY_COLLECTION);

async function fresh(logger = new MemoryLogger()): Promise<MongoHistory> {
  await (await collection()).deleteMany({});
  return new MongoHistory(mongo, logger);
}

describe.skipIf(!MONGO_INT_URI)("MongoHistory contra Mongo", () => {
  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  afterAll(async () => {
    await (await collection()).drop().catch(() => {});
    await mongo.close();
  });

  describeHistoryContract("MongoHistory", () => fresh());

  it("crea sus tres índices, con el de `matchId` único", async () => {
    const history = await fresh();
    history.record([entry(1)]);
    await history.drain();

    const indexes = await (await collection()).indexes();
    expect(indexes.map(({ name }) => name).sort()).toEqual([
      "_id_",
      "createdAt_-1__id_-1",
      "matchId_1",
      "roomId_1",
    ]);
    expect(indexes.find(({ name }) => name === "matchId_1")?.unique).toBe(true);
    // EL DOCUMENTO NO PUEDE NACER DOS VECES, ni siquiera por fuera de la cola de este proceso.
    await expect((await collection()).insertOne({ matchId: "m-1" })).rejects.toThrow(/duplicate/);
  });

  // EL ORDEN FÍSICO, leído crudo y no por `recordOf` —que reordena al leer—: una lectura truncada de
  // la base pierde el final del documento, y el final tiene que ser lo grande. La timeline nace antes
  // que la cabecera cuando alguien se cae durante el sentado, y aun así queda al final.
  it("la cabecera y el cierre dejan los arreglos al final del documento guardado", async () => {
    const history = await fresh();
    history.record([entry(1, { type: "PLAYER_DISCONNECTED", kind: "EVENT", source: "SYSTEM" })]);
    history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
    const opened = async () => Object.keys((await (await collection()).findOne({})) ?? {});
    await history.drain();
    expect((await opened()).at(-1)).toBe("timeline");
    expect((await opened())[0]).toBe("_id");

    history.round("m-1", {
      roundNumber: 1,
      endReason: "DOMINO",
      starterId: "seat-1",
      hands: [],
    });
    history.close("m-1", {
      ...SETUP,
      status: "aborted",
      matchEndedAt: 2_000,
      matchEndReason: "INTERRUPTED",
      winnerIds: [],
      players: [],
      rateId: "r",
      betMultiplier: { offeredValues: [], finalValue: 1, proposals: [] },
      rankingMultiplier: { base: 1, extra: 0, final: 1 },
    });
    await history.drain();
    expect((await opened()).slice(-2)).toEqual(["rounds", "timeline"]);
  });

  // LA FORMA VIEJA —`{ matchId, entries, createdAt, updatedAt }`, con el `at` como número— se sigue
  // leyendo en los tres lectores: la secuencia, el detalle y el listado.
  it("un documento de antes de la v2.1 se lee igual", async () => {
    const history = await fresh();
    const createdAt = new Date("2026-10-01T10:00:00.000Z");
    await (await collection()).insertOne({
      matchId: "m-vieja",
      entries: [entry(2, { matchId: "m-vieja" }), entry(1, { matchId: "m-vieja" })],
      createdAt,
      updatedAt: createdAt,
    });

    expect((await history.of("m-vieja")).map(({ seq, at }) => [seq, at])).toEqual([
      [2, 1_700_000_000_002],
      [1, 1_700_000_000_001],
    ]);
    const record = await history.recordOf("m-vieja");
    expect(record).toMatchObject({ matchId: "m-vieja", createdAt });
    expect(typeof record?._id).toBe("string");
    expect(record?.entries).toHaveLength(2);
    expect(await history.snapshotOf("m-vieja")).toMatchObject({ matchId: "m-vieja" });
    const { items } = await history.page(1, 25);
    expect(items).toEqual([
      { _id: record?._id, matchId: "m-vieja", game: "domino", createdAt, updatedAt: createdAt },
    ]);
  });

  // UN ÍNDICE QUE NO SE PUEDE CREAR NO FRENA EL HISTORIAL: dos filas viejas de la misma partida hacen
  // fallar el único, y el resto de las partidas tiene que seguir grabándose.
  it("si el índice único no se puede crear, lo dice y graba igual", async () => {
    await (await collection()).drop().catch(() => {});
    await (await collection()).insertMany([{ matchId: "dup" }, { matchId: "dup" }]);
    const logger = new MemoryLogger();
    const history = new MongoHistory(mongo, logger);

    history.open("m-nueva", { ...SETUP, matchStartedAt: 1_000 });
    await history.drain();

    expect(await history.recordOf("m-nueva")).toMatchObject({ status: "started" });
    expect(logger.at_("error").map(({ msg }) => msg)).toEqual([
      "historial: no se pudieron crear los índices; se graba igual",
    ]);
    await (await collection()).drop();
  });
});
