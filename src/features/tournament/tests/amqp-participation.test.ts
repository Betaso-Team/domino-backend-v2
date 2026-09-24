import type { AmqpDelivery } from "@/shared/amqp";
import { describe, expect, it } from "vitest";
import type { Participation } from "../participation";
import { AmqpParticipationTransport } from "../transports/amqp-participation";

const REPORT: Participation = {
  tournamentId: "t1",
  matchId: "room-1",
  playerId: "u1",
  username: "gabriel",
  profilePicture: "pic.png",
  score: 3,
  matchScore: 12,
  wins: 1,
  losses: 0,
  gamesPlayed: 1,
  roundsPlayed: 7,
  durationMs: 240_000,
  qualityRatio: 1.1,
  grade: 3,
};

class RecordingDelivery implements AmqpDelivery {
  readonly patterns: { queue: string; pattern: string; data: unknown }[] = [];

  async publishPattern(queue: string, pattern: string, data: unknown): Promise<void> {
    this.patterns.push({ queue, pattern, data });
  }

  async publishTopic(): Promise<void> {
    throw new Error("el reporte no va por exchange");
  }
}

// What this file guards is the CONTRACT: the queue, the pattern and — above all — the renaming of two
// fields. Sending our name where the backend expects theirs is a standings row that never adds,
// silently.
describe("AmqpParticipationTransport", () => {
  it("va a la cola de torneos con el pattern que el consumidor despacha", async () => {
    const queue = new RecordingDelivery();

    await new AmqpParticipationTransport(queue).send(REPORT);

    expect(queue.patterns[0]?.queue).toBe("tournaments_queue");
    expect(queue.patterns[0]?.pattern).toBe("tournament.save-participation");
  });

  it("traduce el vocabulario: playerId → userId y matchId → roomId", async () => {
    const queue = new RecordingDelivery();

    await new AmqpParticipationTransport(queue).send(REPORT);

    const data = queue.patterns[0]?.data as Record<string, unknown>;
    expect(data.userId).toBe("u1");
    expect(data.roomId).toBe("room-1");
    expect(data.playerId).toBeUndefined();
    expect(data.matchId).toBeUndefined();
  });

  it("manda la traza que v1 declara y nunca envía", async () => {
    const queue = new RecordingDelivery();

    await new AmqpParticipationTransport(queue).send(REPORT);

    expect(queue.patterns[0]?.data).toMatchObject({
      roundsPlayed: 7,
      durationMs: 240_000,
      qualityRatio: 1.1,
      grade: 3,
    });
  });
});
