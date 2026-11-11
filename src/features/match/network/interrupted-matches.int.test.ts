import { MemoryKeyValueStore } from "@/shared/kv";
import { Mongo } from "@/shared/mongo";
import { MongoLease } from "@/shared/mongo-lease";
import { MongoOutboxStore } from "@/shared/mongo-outbox";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MatchRegistry } from "../transports/match-registry";
import { InterruptedMatchRecovery } from "./interrupted-matches";
import type { MatchResultKey, MatchResultPayload } from "./match-results";
import { HISTORY_COLLECTION, MongoHistory } from "./transports/mongo-history";

// LA RECUPERACIÓN DE PARTIDAS QUE MURIERON CON SU PROCESO, contra un Mongo de verdad: el registro,
// el outbox con su exclusión por desenlace y el lease son de Mongo; el registro del clúster es el de
// memoria (la misma clase que con Redis). Pide `MONGO_INT_URI` (`src/tests/int-services.ts`).
const OUTBOX = "match_result_outbox_recovery_int";
const LEASES = "game_mode_leases";
const T0 = Date.UTC(2026, 10, 11, 12);
let now = T0;
let mongo: Mongo;

const clock = { now: () => now };
const outbox = () => new MongoOutboxStore<MatchResultKey, MatchResultPayload>(mongo, OUTBOX, clock);

function recovery(registry: MatchRegistry, log = new MemoryLogger()) {
  return new InterruptedMatchRecovery({
    backlog: new MongoHistory(mongo, log),
    liveness: registry,
    outbox: outbox(),
    wake: () => {},
    // Un lease por «proceso»: dueños distintos.
    lease: new MongoLease(mongo, clock),
    now: clock.now,
    log,
  });
}

async function openMatch(matchId: string, updatedAt: number, extra: Record<string, unknown> = {}) {
  await (await mongo.collection(HISTORY_COLLECTION)).insertOne({
    matchId,
    roomId: `room-${matchId}`,
    status: "started",
    table: { gameModeId: "clasica-2p", name: "Clásica" },
    seats: [{ userId: `${matchId}-a` }, { userId: `${matchId}-b` }],
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    ...extra,
  });
}

const OLD = T0 - 11 * 60_000;

describe.skipIf(!MONGO_INT_URI)("InterruptedMatchRecovery contra Mongo", () => {
  beforeAll(() => {
    // UNA BASE PROPIA: `match_history` también la usan otros archivos de integración, en paralelo.
    const uri = new URL(MONGO_INT_URI as string);
    uri.pathname = "/domino_int_recovery";
    mongo = new Mongo(uri.toString());
  });

  beforeEach(async () => {
    now = T0;
    for (const name of [HISTORY_COLLECTION, OUTBOX, LEASES])
      await (await mongo.collection(name)).drop().catch(() => {});
  });

  afterAll(async () => {
    for (const name of [HISTORY_COLLECTION, OUTBOX, LEASES])
      await (await mongo.collection(name)).drop().catch(() => {});
    await mongo.close();
  });

  it("la partida huérfana sale abortada INTERRUPTED y su registro queda cerrado; una sola vez", async () => {
    await openMatch("m-1", OLD, {
      table: { mode: "TOURNAMENT", tournamentId: "t-1", gameModeId: "x" },
    });
    const job = recovery(new MatchRegistry(new MemoryKeyValueStore()));

    expect(await job.pass()).toBe(1);
    expect(await job.pass()).toBe(0);

    const entries = await (await mongo.collection(OUTBOX)).find({}).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      dedupeKey: "m-1:aborted",
      exclusiveKey: "m-1",
      routingKey: "domino.match.aborted",
      status: "PENDING",
      payload: {
        gameSlug: "domino",
        mode: "TOURNAMENT",
        tournamentId: "t-1",
        matchId: "m-1",
        roomId: "room-m-1",
        gameModeId: "x",
        abortedAt: new Date(T0).toISOString(),
        reason: "INTERRUPTED",
        participants: [{ userId: "m-1-a" }, { userId: "m-1-b" }],
      },
    });
    const record = await (await mongo.collection(HISTORY_COLLECTION)).findOne({ matchId: "m-1" });
    expect(record).toMatchObject({
      status: "aborted",
      matchEndReason: "INTERRUPTED",
      recovery: { outcome: "aborted" },
    });
  });

  it("no toca la viva, la reciente, la de resultado retenido ni la que ya tiene desenlace", async () => {
    // Viva: su sala anotada en el registro del clúster.
    const store = new MemoryKeyValueStore();
    const live = new MatchRegistry(store);
    await store.setex("match_room:viva", "room-viva", 120);
    await store.setex("match_config:room-viva", "{}", 120);
    await openMatch("viva", OLD);
    await openMatch("reciente", T0 - 60_000);
    await openMatch("retenida", OLD);
    await live.holdResult("retenida");
    await openMatch("terminada", OLD);
    await outbox().enqueue(
      "terminada:finished",
      "domino.match.finished",
      {} as MatchResultPayload,
      { exclusiveKey: "terminada" },
    );

    expect(await recovery(live).pass()).toBe(0);

    const keys = (await (await mongo.collection(OUTBOX)).find({}).toArray()).map(
      (e) => e.dedupeKey,
    );
    expect(keys).toEqual(["terminada:finished"]);
    const terminada = await (await mongo.collection(HISTORY_COLLECTION)).findOne({
      matchId: "terminada",
    });
    // Su cierre del registro se perdió y el resultado salió: sólo se marca, sigue `started`.
    expect(terminada).toMatchObject({
      status: "started",
      recovery: { outcome: "finished", recordOnly: true },
    });
  });

  it("en carrera: dos procesos recuperando y el desenlace verdadero entrando a la vez, un desenlace por partida", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `r-${i}`);
    for (const id of ids) await openMatch(id, OLD);
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    const [a, b] = [recovery(registry), recovery(registry)];
    const late = outbox();
    await late.hasPending();

    await Promise.all([
      a.pass(),
      b.pass(),
      // El proceso dueño (vivo, con Mongo recién vuelto) encola el `finished` de las pares.
      ...ids
        .filter((_, i) => i % 2 === 0)
        .map((id) =>
          late.enqueue(`${id}:finished`, "domino.match.finished", {} as MatchResultPayload, {
            exclusiveKey: id,
          }),
        ),
    ]);
    // Una pasada más, por si el lease dejó a las dos de arriba sin turno.
    await a.pass();

    const entries = await (await mongo.collection(OUTBOX)).find({}).toArray();
    for (const id of ids) {
      const outcomes = entries.filter((entry) => entry.exclusiveKey === id);
      expect(outcomes, id).toHaveLength(1);
    }
    expect(entries).toHaveLength(ids.length);
  });
});
