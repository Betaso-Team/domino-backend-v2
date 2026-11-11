import type { IndexDescription } from "mongodb";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { CollectionSource } from "./mongo-lease";
import { MongoOutboxStore } from "./mongo-outbox";

// LOS ÍNDICES Y LA CABEZA DE LA COLA, contra un doble del driver. La semántica de la base (el único
// parcial, el orden, la compactación) la mide `mongo-outbox.int.test.ts` contra un Mongo de verdad.

function source(found: unknown = null) {
  const createIndexes = vi.fn(async (_specs: IndexDescription[]) => []);
  const updateOne = vi.fn(async (_filter: unknown, _update: unknown) => ({}));
  const findOne = vi.fn(async (_filter: unknown, _options: unknown) => found);
  const insertOne = vi.fn(async (_document: unknown) => ({}));
  const dropIndex = vi.fn(async (_name: string) => {
    throw Object.assign(new Error("index not found"), { code: 27 });
  });
  const collection = { createIndexes, updateOne, findOne, insertOne, dropIndex };
  const from = { collection: async () => collection } as unknown as CollectionSource;
  return { from, createIndexes, updateOne, findOne, insertOne, dropIndex };
}

const clock = { now: () => Date.UTC(2026, 9, 5) };
const ID = "65f000000000000000000000";

describe("MongoOutboxStore: los índices", () => {
  it("nada vence: borra el TTL viejo de lo enviado y no crea ninguno", async () => {
    const { from, createIndexes, dropIndex } = source();
    await new MongoOutboxStore(from, "match_result_outbox", clock).sent(ID, new Date());
    expect(dropIndex).toHaveBeenCalledWith("sentAt_1");
    expect(createIndexes.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ expireAfterSeconds: expect.anything() }),
    );
  });

  it("la clave exclusiva es única y parcial", async () => {
    const { from, createIndexes } = source();
    await new MongoOutboxStore(from, "match_result_outbox", clock).sent(ID, new Date());
    expect(createIndexes.mock.calls[0]?.[0]).toContainEqual({
      key: { exclusiveKey: 1 },
      name: "exclusiveKey_1",
      unique: true,
      partialFilterExpression: { exclusiveKey: { $exists: true } },
    });
  });
});

// SIN PLAZO POR ENTRADA: la espera tras un fallo es del despachador. Un documento escrito antes trae
// `nextAttemptAt`, y no puede trabar la cola.
describe("MongoOutboxStore: la cabeza de la cola", () => {
  const legacy = {
    _id: new ObjectId(ID),
    dedupeKey: "m-1",
    routingKey: "domino.match.finished",
    payload: { n: 1 },
    status: "PENDING",
    attempts: 3,
    createdAt: new Date(clock.now() - 60_000),
    nextAttemptAt: new Date(clock.now() + 300_000),
  };

  it("`hasPending` es la consulta que cubre `status_1__id_1`", async () => {
    const { from, findOne } = source({ _id: new ObjectId(ID) });
    expect(await new MongoOutboxStore(from, "match_result_outbox", clock).hasPending()).toBe(true);
    expect(findOne).toHaveBeenCalledWith(
      { status: "PENDING" },
      { sort: { _id: 1 }, projection: { _id: 1 } },
    );
  });

  it("`hasPending` sin nada pendiente es falso", async () => {
    const { from } = source(null);
    expect(await new MongoOutboxStore(from, "match_result_outbox", clock).hasPending()).toBe(false);
  });

  it("`next` ordena por intentos y edad, y no mira el `nextAttemptAt` legado", async () => {
    const { from, findOne } = source(legacy);
    const entry = await new MongoOutboxStore(from, "match_result_outbox", clock).next();
    expect(findOne).toHaveBeenCalledWith({ status: "PENDING" }, { sort: { attempts: 1, _id: 1 } });
    expect(entry).toEqual({
      id: ID,
      dedupeKey: "m-1",
      routingKey: "domino.match.finished",
      payload: { n: 1 },
      status: "PENDING",
      attempts: 3,
      strikes: 0,
      createdAt: legacy.createdAt,
      sentAt: undefined,
      lastError: undefined,
    });
  });

  it("`retry` suma el intento y guarda el error, sin agendar nada", async () => {
    const { from, updateOne } = source();
    await new MongoOutboxStore(from, "match_result_outbox", clock).retry(ID, "caído");
    expect(updateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(ID) },
      { $set: { lastError: "caído" }, $inc: { attempts: 1 } },
    );
  });

  it("`retry` con strike lo suma aparte", async () => {
    const { from, updateOne } = source();
    await new MongoOutboxStore(from, "match_result_outbox", clock).retry(ID, "devuelto", true);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(ID) },
      { $set: { lastError: "devuelto" }, $inc: { attempts: 1, strikes: 1 } },
    );
  });

  it("encolar ya no escribe `nextAttemptAt`", async () => {
    const { from, insertOne } = source();
    await new MongoOutboxStore(from, "match_result_outbox", clock).enqueue("k", "r", 1);
    expect(insertOne.mock.calls[0]?.[0]).not.toHaveProperty("nextAttemptAt");
  });
});
