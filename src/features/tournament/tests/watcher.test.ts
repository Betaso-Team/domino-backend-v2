import type { AmqpDelivery } from "@/shared/amqp";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { FakeTournamentClient } from "@/tests/fake-client";
import { beforeEach, describe, expect, it } from "vitest";
import type { TournamentInfo, TournamentStatus } from "../client";
import { TournamentWatcher } from "../watcher";

const INFO = (status: TournamentStatus): TournamentInfo => ({
  status,
  name: "Torneo de los martes",
  pointsPerLoss: 1,
  playersQuantity: 2,
  pointsToWin: 12,
});

class RecordingDelivery implements AmqpDelivery {
  readonly topics: { exchange: string; routingKey: string; body: unknown }[] = [];

  async publishPattern(): Promise<void> {
    throw new Error("el games-check no va por cola directa");
  }

  async publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void> {
    this.topics.push({ exchange, routingKey, body });
  }
}

// What this file guards is the one notice that unblocks a payout: the backend marks a tournament
// finished and hands out no prizes until it knows no match is still being played.
describe("El vigía del torneo", () => {
  let client: FakeTournamentClient;
  let publisher: RecordingDelivery;
  let live: string[];

  const build = () =>
    new TournamentWatcher({
      client,
      publisher,
      liveTournaments: async () => live,
      intervalMs: 120_000,
      log: new MemoryLogger(),
    });

  const bodies = () => publisher.topics.map((t) => t.body);

  beforeEach(() => {
    client = new FakeTournamentClient();
    client.setInfo("t1", INFO("IN_GAME"));
    publisher = new RecordingDelivery();
    live = ["t1"];
  });

  it("mientras se está jugando no dice nada", async () => {
    await build().tick();

    expect(publisher.topics).toEqual([]);
  });

  it("terminado y con partidas en curso, contesta que todavía no", async () => {
    const watcher = build();
    await watcher.tick();
    client.setInfo("t1", INFO("FINISHED"));

    await watcher.tick();

    expect(publisher.topics[0]?.exchange).toBe("betaso");
    expect(publisher.topics[0]?.routingKey).toBe("tournament.games-check");
    expect(bodies()).toEqual([{ tournamentId: "t1", hasPendingGames: true }]);
  });

  // The notice that matters: without it the tournament never hands its prizes out.
  it("terminado y sin partidas, contesta que ya no queda ninguna", async () => {
    const watcher = build();
    await watcher.tick();
    client.setInfo("t1", INFO("FINISHED"));
    live = [];

    await watcher.tick();

    expect(bodies()).toEqual([{ tournamentId: "t1", hasPendingGames: false }]);
  });

  // Which is why a tournament is not dropped when it runs out of matches: that is precisely when
  // there is something to say.
  it("sigue mirando un torneo que ya no tiene partidas", async () => {
    const watcher = build();
    await watcher.tick();
    client.setInfo("t1", INFO("FINISHED"));
    live = [];

    await watcher.tick();
    await watcher.tick();

    expect(bodies()).toHaveLength(2);
  });

  it("cuando el backend dice que ya pagó, deja de mirarlo", async () => {
    const watcher = build();
    await watcher.tick();
    client.setInfo("t1", INFO("PAID"));
    live = [];

    await watcher.tick();
    client.setInfo("t1", INFO("FINISHED"));
    await watcher.tick();

    expect(publisher.topics).toEqual([]);
  });

  it("un torneo cancelado tampoco se mira más", async () => {
    const watcher = build();
    await watcher.tick();
    client.setInfo("t1", INFO("CANCELED"));
    live = [];

    await watcher.tick();
    client.setInfo("t1", INFO("FINISHED"));
    await watcher.tick();

    expect(publisher.topics).toEqual([]);
  });

  it("un torneo que no contesta no se lleva puestos a los demás", async () => {
    client.setInfo("t2", INFO("FINISHED"));
    live = ["t1", "t2"];
    const watcher = build();
    await watcher.tick();
    // The first disappears from the backend; the second keeps answering.
    client.setInfo("t2", INFO("FINISHED"));
    live = [];

    await watcher.tick();

    expect(bodies()).toContainEqual({ tournamentId: "t2", hasPendingGames: false });
  });

  it("el que falló se reintenta en la pasada siguiente", async () => {
    const watcher = build();
    await watcher.tick();
    client.setFailing(true);
    await watcher.tick();

    client.setFailing(false);
    client.setInfo("t1", INFO("FINISHED"));
    live = [];
    await watcher.tick();

    expect(bodies()).toEqual([{ tournamentId: "t1", hasPendingGames: false }]);
  });
});
