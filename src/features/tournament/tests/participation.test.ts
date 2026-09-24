import { FakeParticipationTransport } from "@/features/tournament/tests/fake-participation";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it, vi } from "vitest";
import { type Participation, ParticipationReporter } from "../participation";

const winner: Participation = {
  tournamentId: "t1",
  matchId: "m1",
  playerId: "u1",
  username: "uno",
  profilePicture: "",
  score: 3,
  matchScore: 12,
  wins: 1,
  losses: 0,
  gamesPlayed: 1,
  roundsPlayed: 7,
  durationMs: 200_000,
  qualityRatio: 1.01,
  grade: 3,
};

// The retry has real backoff: with fake timers, testing it costs no seconds.
async function drainWithFakeTimers(reporter: ParticipationReporter): Promise<void> {
  const drained = reporter.drain();
  await vi.runAllTimersAsync();
  await drained;
}

describe("El reporte de participación", () => {
  it("viaja con su traza de calidad, que es lo que v1 declara y nunca manda", async () => {
    vi.useFakeTimers();
    const transport = new FakeParticipationTransport();
    const reporter = new ParticipationReporter(transport, new MemoryLogger());

    reporter.report(winner);
    await drainWithFakeTimers(reporter);

    expect(transport.sent[0]).toMatchObject({
      score: 3,
      roundsPlayed: 7,
      durationMs: 200_000,
      qualityRatio: 1.01,
      grade: 3,
    });
    vi.useRealTimers();
  });

  // The guard that matters most: the main backend increments the standings, so reporting the same
  // match twice ADDS twice. The idempotency has to be on this side.
  it("reportar dos veces la misma partida no suma dos veces", async () => {
    vi.useFakeTimers();
    const transport = new FakeParticipationTransport();
    const reporter = new ParticipationReporter(transport, new MemoryLogger());

    expect(reporter.report(winner)).toBe(true);
    expect(reporter.report(winner)).toBe(false);
    await drainWithFakeTimers(reporter);

    expect(transport.sent).toHaveLength(1);
    vi.useRealTimers();
  });

  it("la clave es por JUGADOR: los dos de una misma partida se reportan", async () => {
    vi.useFakeTimers();
    const transport = new FakeParticipationTransport();
    const reporter = new ParticipationReporter(transport, new MemoryLogger());

    reporter.report(winner);
    reporter.report({ ...winner, playerId: "u2", score: 0, wins: 0, losses: 1 });
    await drainWithFakeTimers(reporter);

    expect(transport.sent).toHaveLength(2);
    vi.useRealTimers();
  });

  it("si la cola está caída reintenta, y lo consigue", async () => {
    vi.useFakeTimers();
    const transport = new FakeParticipationTransport();
    let attempts = 0;
    vi.spyOn(transport, "send").mockImplementation(async (p) => {
      attempts++;
      if (attempts < 3) throw new Error("cola caída");
      transport.sent.push(p);
    });
    const reporter = new ParticipationReporter(transport, new MemoryLogger());

    reporter.report(winner);
    await drainWithFakeTimers(reporter);

    expect(attempts).toBe(3);
    expect(reporter.unreported).toEqual([]);
    vi.useRealTimers();
  });

  it("si nunca entra queda a la vista, y la clave se libera para poder reintentarlo", async () => {
    vi.useFakeTimers();
    const transport = new FakeParticipationTransport();
    transport.setFailing(true);
    const reporter = new ParticipationReporter(transport, new MemoryLogger());

    reporter.report(winner);
    await drainWithFakeTimers(reporter);

    expect(transport.sent).toEqual([]);
    expect(reporter.unreported).toEqual([winner]);
    // Liberada: si quedara tomada, reconciliar a mano sería imposible.
    expect(reporter.report(winner)).toBe(true);
    vi.useRealTimers();
  });
});
