import type { Logger } from "@/logger";
import { type Lease, MemoryLease } from "@/shared/mongo-lease";
import { describe, expect, it, vi } from "vitest";
import type { PlayerStatsStore, StatsLine } from "./player-stats";
import { PlayerStatsRecorder, recordingStats } from "./player-stats-recorder";
import { MemoryHistory } from "./transports/memory-history";
import { MemoryPlayerStats } from "./transports/memory-player-stats";
import { CLOSING, SETUP } from "./transports/tests/history-contract";

const logger = () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return log as unknown as Logger & typeof log;
};

const AFTER = new Date(CLOSING.matchEndedAt + 11_000);
const FAR = new Date(CLOSING.matchEndedAt + 3_600_000);

function build(over: { store?: PlayerStatsStore; lease?: Lease } = {}) {
  const history = new MemoryHistory();
  const memory = new MemoryPlayerStats();
  const log = logger();
  const recorder = new PlayerStatsRecorder({
    store: over.store ?? memory,
    backlog: history,
    lease: over.lease ?? new MemoryLease(),
    logger: log,
    now: () => AFTER,
  });
  return { history, memory, log, recorder };
}

describe("PlayerStatsRecorder", () => {
  it("al cerrar una 2P terminada aplica y deja la partida settled", async () => {
    const { history, memory, recorder } = build();
    const port = recordingStats(history, recorder);
    port.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
    port.close("m-1", CLOSING);
    await port.drain();
    expect((await memory.of("u1")).gamesWon).toBe(1);
    expect(await history.pending(FAR, 10)).toEqual([]);
  });

  it("una partida anulada no aplica nada ni queda pendiente", async () => {
    const { history, memory, recorder } = build();
    const port = recordingStats(history, recorder);
    port.close("m-1", { ...CLOSING, status: "aborted" });
    await port.drain();
    expect((await memory.of("u1")).gamesPlayed).toBe(0);
    expect(await history.pending(FAR, 10)).toEqual([]);
  });

  it("un close repetido deja los contadores en 1", async () => {
    const { history, memory, recorder } = build();
    const port = recordingStats(history, recorder);
    port.close("m-1", CLOSING);
    port.close("m-1", CLOSING);
    await port.drain();
    expect((await memory.of("u1")).gamesPlayed).toBe(1);
    expect((await memory.of("u2")).gamesPlayed).toBe(1);
  });

  it("si apply lanza: drain no rechaza, se loguea y el barrido la aplica", async () => {
    const memory = new MemoryPlayerStats();
    let fail = true;
    const store: PlayerStatsStore = {
      of: (id) => memory.of(id),
      apply: (line: StatsLine) => {
        if (fail) throw new Error("boom");
        return memory.apply(line);
      },
    };
    const { history, log, recorder } = build({ store });
    const port = recordingStats(history, recorder);
    port.close("m-1", CLOSING);
    await expect(port.drain()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
    expect(await history.pending(FAR, 10)).toHaveLength(1);

    fail = false;
    await recorder.sweep();
    expect((await memory.of("u1")).gamesWon).toBe(1);
    expect(await history.pending(FAR, 10)).toEqual([]);
  });

  it("sweep aplica dos pendientes de jugadores distintos", async () => {
    const { history, memory, recorder } = build();
    history.close("m-1", CLOSING);
    history.close("m-2", {
      ...CLOSING,
      matchEndedAt: CLOSING.matchEndedAt + 1,
      players: CLOSING.players.map((p, i) => ({ ...p, userId: i === 0 ? "u3" : "u4" })),
    });
    await history.drain();
    await recorder.sweep();
    for (const id of ["u1", "u2", "u3", "u4"]) expect((await memory.of(id)).gamesPlayed).toBe(1);
    expect(await history.pending(FAR, 10)).toEqual([]);
  });

  it("un skipped por orden se loguea como warn y la partida queda settled", async () => {
    const { history, memory, log, recorder } = build();
    await memory.apply({
      userId: "u1",
      endedAt: new Date(CLOSING.matchEndedAt + 5_000),
      result: "win",
      fourPlayers: false,
    });
    history.close("m-1", CLOSING);
    await history.drain();
    await recorder.sweep();
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { matchId: "m-1", userId: "u1" });
    expect(await history.pending(FAR, 10)).toEqual([]);
  });

  it("sweep no hace nada si el lease no se obtiene", async () => {
    const lease: Lease = { within: async () => undefined };
    const { history, memory, recorder } = build({ lease });
    history.close("m-1", CLOSING);
    await history.drain();
    await recorder.sweep();
    expect((await memory.of("u1")).gamesPlayed).toBe(0);
  });

  it("sweep sobrevive a un error de pending", async () => {
    const { history, log, recorder } = build();
    vi.spyOn(history, "pending").mockRejectedValue(new Error("timeout"));
    await expect(recorder.sweep()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it("el drain del decorador ESPERA el del historial de adentro", async () => {
    const { history, recorder } = build();
    let release: () => void = () => undefined;
    let finished = false;
    vi.spyOn(history, "drain").mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        finished = true;
      }),
    );
    const draining = recordingStats(history, recorder)
      .drain()
      .then(() => finished);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect(await draining).toBe(true);
  });

  it("dos sweep superpuestos corren uno solo, y drain espera al lento", async () => {
    const { history, recorder } = build();
    let release: (value: []) => void = () => undefined;
    const pending = vi.spyOn(history, "pending").mockReturnValue(
      new Promise<[]>((resolve) => {
        release = resolve;
      }),
    );
    const first = recorder.sweep();
    const second = recorder.sweep();
    let drained = false;
    const draining = recorder.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    release([]);
    await Promise.all([first, second, draining]);
    expect(drained).toBe(true);
    await recorder.sweep();
    expect(pending).toHaveBeenCalledTimes(2);
  });
});
