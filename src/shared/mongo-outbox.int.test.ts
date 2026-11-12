import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Mongo } from "./mongo";
import { MongoOutboxStore } from "./mongo-outbox";

// EL OUTBOX CONTRA UN MONGO DE VERDAD: el único parcial que excluye un desenlace del otro (también
// con los dos inserts en carrera), el orden `(attempts, _id)`, el estacionamiento, la compactación que
// reemplazó al TTL y el borrado del TTL viejo. Pide `MONGO_INT_URI` (`src/tests/int-services.ts`).
const COLLECTION = "match_result_outbox_int";
let mongo: Mongo;
let now = Date.UTC(2026, 10, 11);
const clock = { now: () => now };
const store = () => new MongoOutboxStore<string, { n: number }>(mongo, COLLECTION, clock);

describe.skipIf(!MONGO_INT_URI)("MongoOutboxStore contra Mongo", () => {
  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  beforeEach(async () => {
    await (await mongo.collection(COLLECTION)).drop().catch(() => {});
    now = Date.UTC(2026, 10, 11);
  });

  afterAll(async () => {
    await (await mongo.collection(COLLECTION)).drop().catch(() => {});
    await mongo.close();
  });

  it("un desenlace excluye al otro: finished y aborted de la misma partida no conviven", async () => {
    const outbox = store();
    expect(await outbox.enqueue("m-1:finished", "f", { n: 1 }, { exclusiveKey: "m-1" })).toBe(true);
    expect(await outbox.enqueue("m-1:aborted", "a", { n: 2 }, { exclusiveKey: "m-1" })).toBe(false);
    expect([...(await outbox.present(["m-1:finished", "m-1:aborted"]))]).toEqual(["m-1:finished"]);
    // Sin clave exclusiva no hay exclusión: el índice es parcial.
    expect(await outbox.enqueue("x", "r", { n: 3 })).toBe(true);
    expect(await outbox.enqueue("y", "r", { n: 4 })).toBe(true);
  });

  it("en carrera, de veinte inserts de los dos desenlaces de cada partida entra uno solo", async () => {
    // Dos instancias del store (dos procesos) contra la misma colección, ya preparada.
    const [a, b] = [store(), store()];
    await a.hasPending();
    await b.hasPending();
    const matches = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const results = await Promise.all(
      matches.flatMap((matchId) => [
        a.enqueue(`${matchId}:finished`, "f", { n: 1 }, { exclusiveKey: matchId }),
        b.enqueue(`${matchId}:aborted`, "a", { n: 2 }, { exclusiveKey: matchId }),
      ]),
    );
    for (let i = 0; i < matches.length; i += 1) {
      expect(Number(results[2 * i]) + Number(results[2 * i + 1])).toBe(1);
    }
    const all = await (await mongo.collection(COLLECTION)).countDocuments({});
    expect(all).toBe(10);
  });

  it("`next` da el de menos intentos y, entre iguales, el más viejo", async () => {
    const outbox = store();
    await outbox.enqueue("a", "r", { n: 1 });
    await outbox.enqueue("b", "r", { n: 2 });
    const first = await outbox.next();
    expect(first?.dedupeKey).toBe("a");
    await outbox.retry(first?.id ?? "", "caído");
    expect((await outbox.next())?.dedupeKey).toBe("b");
  });

  it("estacionar saca de la cola, se cuenta y nunca se borra; sólo una PENDING", async () => {
    const outbox = store();
    await outbox.enqueue("a", "r", { n: 1 });
    await outbox.enqueue("b", "r", { n: 2 });
    const a = await outbox.next();
    await outbox.retry(a?.id ?? "", "devuelto", true);
    await outbox.park(a?.id ?? "", "devuelto", new Date(now));
    const b = await outbox.next();
    await outbox.sent(b?.id ?? "", new Date(now));
    await outbox.park(b?.id ?? "", "tarde", new Date(now));

    expect(await outbox.parkedCount()).toBe(1);
    expect(await outbox.hasPending()).toBe(false);
    expect(await outbox.statuses(["a", "b"])).toEqual(
      new Map([
        ["a", "PARKED"],
        ["b", "SENT"],
      ]),
    );
    const parked = await (await mongo.collection(COLLECTION)).findOne({ dedupeKey: "a" });
    expect(parked).toMatchObject({ strikes: 1, attempts: 1, payload: { n: 1 } });
  });

  it("lo enviado se compacta (sin cuerpo) y sigue contestando su estado", async () => {
    const outbox = store();
    await outbox.enqueue("a", "r", { n: 1 }, { exclusiveKey: "m" });
    const a = await outbox.next();
    await outbox.sent(a?.id ?? "", new Date(now));
    now += 8 * 24 * 3600_000;

    expect(await outbox.compactSent(7 * 24 * 3600_000)).toBe(1);
    expect(await outbox.compactSent(7 * 24 * 3600_000)).toBe(0);
    expect(await outbox.statuses(["a"])).toEqual(new Map([["a", "SENT"]]));
    const doc = await (await mongo.collection(COLLECTION)).findOne({ dedupeKey: "a" });
    expect(doc).not.toHaveProperty("payload");
    // La lápida sigue excluyendo al otro desenlace.
    expect(await outbox.enqueue("b", "r", { n: 2 }, { exclusiveKey: "m" })).toBe(false);
  });

  it("borra el índice TTL viejo que borraba lo enviado", async () => {
    const collection = await mongo.collection(COLLECTION);
    await collection.createIndex({ sentAt: 1 }, { name: "sentAt_1", expireAfterSeconds: 60 });
    await store().hasPending();
    const names = (await collection.indexes()).map((index) => index.name);
    expect(names).not.toContain("sentAt_1");
    expect(names).toContain("exclusiveKey_1");
  });
});
