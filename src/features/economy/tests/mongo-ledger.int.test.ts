import { Mongo } from "@/shared/mongo";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DuplicateMovementError } from "../ledger";
import { MongoLedger } from "../transports/mongo-ledger";

// A CONTRACT test against a real Mongo. What it guards is what a fake driver cannot test: that the
// duplicate is rejected by THE DATABASE and not by a check of ours, which would have a gap between
// read and write; that the row carries the version mark, since v1 shares the collection; and that the
// expiry tells what expires from what somebody has to look at.
const COLLECTION = "test_movements";

// ⚠ PIDE UN MONGO DE VERDAD: lee `MONGO_INT_URI` y se saltea sin ella. El porqué —y por qué
// no es `MONGO_URI`— está en `src/tests/int-services.ts`, que es el único que la lee.
describe.skipIf(!MONGO_INT_URI)("MongoLedger (contrato con la colección de v1)", () => {
  let mongo: Mongo;
  let ledger: MongoLedger;
  let clock = 1_700_000_000_000;

  const entry = { matchId: "room-1", playerId: "u1", amount: 10, reason: "ENTRY_FEE" as const };
  // The RAW document is read — not what the port returns — because what has to be asserted is the
  // shape left in the database, which is the one shared with v1.
  const raw = async (id: string): Promise<Record<string, unknown> | null> =>
    (await mongo.collection(COLLECTION)).findOne({ _id: id } as never);

  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
    ledger = new MongoLedger(mongo, COLLECTION, () => clock);
  });

  afterAll(async () => {
    await (await mongo.collection(COLLECTION)).drop().catch(() => {});
    await mongo.close();
  });

  beforeEach(async () => {
    clock = 1_700_000_000_000;
    await (await mongo.collection(COLLECTION)).deleteMany({});
  });

  it("la fila lleva los campos de v1 y la marca de versión", async () => {
    await ledger.reserve(entry);

    expect(await raw("room-1:u1:ENTRY_FEE")).toMatchObject({
      roomId: "room-1",
      tokenId: "room-1",
      userId: "u1",
      amount: 10,
      reason: "ENTRY_FEE",
      status: "PENDING",
      version: 2,
    });
  });

  // The duplicate is rejected by the `_id`, which is to say by the DATABASE. With a check of ours
  // there would be a gap between read and write for a second charge to slip through.
  it("reservar dos veces la misma tupla la rechaza la base", async () => {
    await ledger.reserve(entry);

    await expect(ledger.reserve(entry)).rejects.toBeInstanceOf(DuplicateMovementError);
  });

  it("la razón es parte de la clave: el multiplicador no choca con la entrada", async () => {
    await ledger.reserve(entry);

    await expect(ledger.reserve({ ...entry, reason: "BET_MULTIPLIER" })).resolves.toBeDefined();
  });

  it("liquidar y fallar cambian el estado, y el fallido deja de caducar", async () => {
    await ledger.reserve(entry);
    expect((await raw("room-1:u1:ENTRY_FEE"))?.expiresAt).toBeInstanceOf(Date);

    await ledger.fail(entry);

    expect(await ledger.statusOf("room-1", "u1", "ENTRY_FEE")).toBe("FAILED");
    // What went wrong is precisely what has to be kept until somebody resolves it.
    expect((await raw("room-1:u1:ENTRY_FEE"))?.expiresAt).toBeUndefined();
  });

  it("lo apostado en una partida se lee por roomId", async () => {
    await ledger.reserve(entry);
    await ledger.reserve({ ...entry, reason: "BET_MULTIPLIER", amount: 5 });
    await ledger.reserve({ ...entry, matchId: "otra" });

    expect((await ledger.entriesOf("room-1")).map((e) => e.amount).sort((a, b) => a - b)).toEqual([
      5, 10,
    ]);
  });

  describe("lo que quedó a medias, al arrancar", () => {
    it("marca el PENDING como interrumpido, SIN tocar la plata", async () => {
      await ledger.reserve(entry);

      expect(await ledger.markInterrupted()).toBe(1);

      const document = await raw("room-1:u1:ENTRY_FEE");
      // The status does NOT change: it stays `PENDING`, because whether the charge landed is unknown.
      // What is added is the mark, which is another axis.
      expect(document?.status).toBe("PENDING");
      expect(document?.review).toMatchObject({ reason: "INTERRUPTED", statusAtMark: "PENDING" });
      expect(document?.expiresAt).toBeUndefined();
    });

    it("y el FAILED como no entregado, que es otra cosa", async () => {
      await ledger.reserve(entry);
      await ledger.fail(entry);

      await ledger.markInterrupted();

      expect((await raw("room-1:u1:ENTRY_FEE"))?.review).toMatchObject({
        reason: "UNDELIVERED",
        statusAtMark: "FAILED",
      });
    });

    it("no vuelve a marcar lo ya marcado", async () => {
      await ledger.reserve(entry);
      await ledger.markInterrupted();

      expect(await ledger.markInterrupted()).toBe(0);
    });

    it("lo liquidado no necesita que nadie lo mire", async () => {
      await ledger.reserve(entry);
      await ledger.settle(entry);

      expect(await ledger.markInterrupted()).toBe(0);
      expect(await ledger.needsReview()).toEqual([]);
    });

    it("lo marcado se puede listar, que es lo que espera una persona", async () => {
      await ledger.reserve(entry);
      await ledger.markInterrupted();

      const pending = await ledger.needsReview();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.review?.reason).toBe("INTERRUPTED");
    });
  });
});
