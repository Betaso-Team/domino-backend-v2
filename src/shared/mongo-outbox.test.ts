import type { IndexDescription } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { CollectionSource } from "./mongo-lease";
import { MongoOutboxStore } from "./mongo-outbox";

// EL VENCIMIENTO DE LO ENVIADO, y solo de lo enviado. Mongo no vence un documento sin el campo del
// índice TTL, y una entrada pendiente no tiene `sentAt`: lo que no salió no vence nunca, por
// construcción. Lo que salió se borra solo después del plazo.

function source() {
  const createIndexes = vi.fn(async (_specs: IndexDescription[]) => []);
  const collection = { createIndexes, updateOne: vi.fn(async () => ({})) };
  const from = { collection: async () => collection } as unknown as CollectionSource;
  return { from, createIndexes };
}

const clock = { now: () => Date.UTC(2026, 9, 5) };
const ID = "65f000000000000000000000";

describe("MongoOutboxStore: los índices", () => {
  it("sin plazo no vence nada: el catálogo necesita sus enviados para siempre", async () => {
    const { from, createIndexes } = source();
    await new MongoOutboxStore(from, "game_mode_outbox", clock).sent(ID, new Date());
    expect(createIndexes.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ expireAfterSeconds: expect.anything() }),
    );
  });

  it("con plazo, vence lo enviado por `sentAt`", async () => {
    const { from, createIndexes } = source();
    const store = new MongoOutboxStore(from, "match_result_outbox", clock, {
      sentRetentionSeconds: 7 * 24 * 3600,
    });
    await store.sent(ID, new Date());
    expect(createIndexes.mock.calls[0]?.[0]).toContainEqual({
      key: { sentAt: 1 },
      name: "sentAt_1",
      expireAfterSeconds: 604_800,
    });
  });
});
