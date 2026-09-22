import { AlwaysOnAntifraudFlag } from "@/features/matchmaking/tests/always-on-flag";
import { MemoryKeyValueStore } from "@/shared/kv";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { CachedAntifraudFlag } from "../antifraud-flag";
import { CooldownBook, DEFAULT_COOLDOWN } from "../core/cooldown";
import { matchmakingSink } from "../feedback";
import { CASUAL_SCOPE, VetoBook, casualVetoKey } from "../veto";

// THE BRIDGE between a match and matchmaking. What is tested is that the facts the scope decides end
// up written in the books matchmaking reads — with neither feature importing the other.

function setup(enabled = true) {
  const clock = { now: 1000 };
  const kv = new MemoryKeyValueStore(() => clock.now);
  const cooldown = new CooldownBook(
    kv,
    DEFAULT_COOLDOWN,
    () => clock.now,
    <T>(i: readonly T[]) => [...i],
  );
  const veto = new VetoBook(kv, casualVetoKey, { ttlMs: 30 * 60_000 });
  const sink = matchmakingSink(
    { cooldown, veto, isCasualVetoEnabled: async () => enabled, log: new MemoryLogger() },
    { poolId: "mesa", playerIds: ["u1", "u2"] },
  );
  return { sink, cooldown, veto, clock };
}

// The sink is synchronous by contract and the books live in Redis, so its writes stay in flight: the
// microtasks have to run before the result is looked at.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("El sink del emparejamiento", () => {
  it("al cerrar la partida reparte el cooldown", async () => {
    const s = setup();

    s.sink([{ type: "MATCH_RESOLVED", winnerTeamId: "A" }]);

    await settle();

    expect(await s.cooldown.consume("mesa", "u1")).toBe(2_000);
    expect(await s.cooldown.consume("mesa", "u2")).toBe(7_000);
  });

  // BOTH endings count. The cooldown punishes nothing: it only keeps both from returning to the queue
  // at the same instant, which holds whether the match fell over or not.
  it("una partida abortada también reparte cooldown", async () => {
    const s = setup();

    s.sink([{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }]);

    await settle();

    expect(await s.cooldown.consume("mesa", "u1")).toBe(2_000);
  });

  it("anota el veto de torneo que decidió el ámbito, en SU torneo", async () => {
    const s = setup();

    s.sink([{ type: "PAIR_VETOED", tournamentId: "t1", playerIds: ["u1", "u2"] }]);

    expect(await s.veto.isVetoed("t1", "u1", "u2")).toBe(true);
  });

  it("el veto casual se anota en el ámbito global de la cuenta", async () => {
    const s = setup();

    s.sink([{ type: "CASUAL_PAIR_VETOED", playerIds: ["u1", "u2"] }]);
    await Promise.resolve(); // el interruptor se consulta async

    expect(await s.veto.isVetoed(CASUAL_SCOPE, "u1", "u2")).toBe(true);
  });

  // The switch governs ONLY the casual veto: the lever product pulls when the pool is thin and
  // avoiding pairs stretches the waits too far.
  it("con el interruptor apagado, el veto casual no se anota", async () => {
    const s = setup(false);

    s.sink([{ type: "CASUAL_PAIR_VETOED", playerIds: ["u1", "u2"] }]);
    await Promise.resolve();

    expect(await s.veto.isVetoed(CASUAL_SCOPE, "u1", "u2")).toBe(false);
  });

  it("el de torneo NO lo consulta: ése no se apaga", async () => {
    const s = setup(false);

    s.sink([{ type: "PAIR_VETOED", tournamentId: "t1", playerIds: ["u1", "u2"] }]);

    expect(await s.veto.isVetoed("t1", "u1", "u2")).toBe(true);
  });

  it("lo que no le toca lo ignora", async () => {
    const s = setup();

    s.sink([
      { type: "ROUND_RESOLVED", roundNumber: 1 },
      { type: "ENTRY_CHARGED", playerId: "u1" },
    ]);

    await settle();

    expect(await s.cooldown.consume("mesa", "u1")).toBe(0);
  });
});

describe("El interruptor antifraude", () => {
  it("cachea: N partidas cerrando a la vez no son N consultas", async () => {
    let calls = 0;
    const clock = { now: 1000 };
    const flag = new CachedAntifraudFlag(
      {
        isRematchRulesEnabled: async () => {
          calls++;
          return true;
        },
      },
      5_000,
      () => clock.now,
      new MemoryLogger(),
    );

    await Promise.all([flag.isRematchRulesEnabled(), flag.isRematchRulesEnabled()]);
    await flag.isRematchRulesEnabled();

    expect(calls).toBe(1);
  });

  it("la cache es corta: el toggle tiene que hacer efecto casi en el acto", async () => {
    let calls = 0;
    const clock = { now: 1000 };
    const flag = new CachedAntifraudFlag(
      {
        isRematchRulesEnabled: async () => {
          calls++;
          return true;
        },
      },
      5_000,
      () => clock.now,
      new MemoryLogger(),
    );

    await flag.isRematchRulesEnabled();
    clock.now += 5_001;
    await flag.isRematchRulesEnabled();

    expect(calls).toBe(2);
  });

  // The safe side is preferred: whoever could take that endpoint down does not turn the protection
  // off. The cost is bounded — the veto is a preference, so the worst case is waiting until the escape
  // hatch.
  it("si el backend no contesta, el veto SIGUE VIGENTE", async () => {
    const flag = new CachedAntifraudFlag(
      {
        isRematchRulesEnabled: async () => {
          throw new Error("backend caído");
        },
      },
      5_000,
      () => 1000,
      new MemoryLogger(),
    );

    expect(await flag.isRematchRulesEnabled()).toBe(true);
  });

  it("la fuente de hoy dice que sí", async () => {
    expect(await new AlwaysOnAntifraudFlag().isRematchRulesEnabled()).toBe(true);
  });
});
