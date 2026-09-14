import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import {
  type SeatedMatch,
  act,
  bootServer,
  clientOf,
  historyOf,
  linesOf,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2590);
});

afterAll(async () => {
  await server.shutdown();
});

const seenOf = (state: MatchState, playerId: string): boolean =>
  state.players.find((player) => player.playerId === playerId)?.hasSeenTiles ?? false;

const revealTiles = async (match: SeatedMatch, playerId: string): Promise<void> => {
  clientOf(match, playerId).send("REVEAL_TILES", {});
  await waitUntil(() => seenOf(match.serverState, playerId));
};

const tilesSeenBy = (match: SeatedMatch, viewerId: string, ownerId: string) => [
  ...((clientOf(match, viewerId).state as MatchState).players.find(
    (player) => player.playerId === ownerId,
  )?.hand.tiles ?? []),
];

describe("ventana de reparto", () => {
  it("reparte tapado y espera a que ambos levanten antes de dar el turno", async () => {
    const match = await seatPair(server, ["deal-d1", "deal-d2"]);

    expect(match.serverState.currentRound?.phase).toBe("DEALING");
    expect(match.serverState.players.map((player) => player.hand.tileCount)).toEqual([7, 7]);
    expect(tilesSeenBy(match, "deal-d1", "deal-d1")).toHaveLength(0);
    expect(tilesSeenBy(match, "deal-d2", "deal-d2")).toHaveLength(0);

    await revealTiles(match, "deal-d1");

    expect(seenOf(match.serverState, "deal-d1")).toBe(true);
    expect(seenOf(match.serverState, "deal-d2")).toBe(false);
    expect(match.serverState.currentRound?.phase).toBe("DEALING");

    await act(match, "deal-d2", "REVEAL_TILES");

    expect(match.serverState.currentRound?.phase).toBe("PLAYING");
    expect(match.serverState.currentRound?.currentTurn?.playerId).toBeTruthy();
  });

  it("revelar hace visible la mano solo para su dueño", async () => {
    const match = await seatPair(server, ["deal-v1", "deal-v2"]);

    await revealTiles(match, "deal-v1");
    await waitUntil(
      () =>
        tilesSeenBy(match, "deal-v1", "deal-v1").length === 7 &&
        seenOf(clientOf(match, "deal-v2").state as MatchState, "deal-v1"),
    );

    expect(tilesSeenBy(match, "deal-v1", "deal-v1")).toHaveLength(7);
    expect(tilesSeenBy(match, "deal-v2", "deal-v1")).toHaveLength(0);
  });

  it("retira al ausente y resuelve por forfeit cuando solo uno levanta", async () => {
    const match = await seatPair(server, ["deal-f1", "deal-f2"]);
    const matchId = "m-deal-f1-deal-f2";

    await revealTiles(match, "deal-f1");
    await waitUntil(
      () =>
        match.serverState.players.find((player) => player.playerId === "deal-f2")?.hasAbandoned ===
        true,
      5_000,
    );

    const winnerTeamId = match.serverState.players.find(
      (player) => player.playerId === "deal-f1",
    )?.teamId;
    expect(linesOf(matchId)).toContain("SYSTEM ABANDON");
    expect(linesOf(matchId)).toContain("SYSTEM MATCH_RESOLVED");
    expect(historyOf(matchId).find((entry) => entry.type === "MATCH_RESOLVED")?.payload).toEqual({
      winnerTeamId,
      reason: "ABANDONMENT",
    });
  }, 7_000);

  it("si nadie levanta abandona a ambos, no inventa ganador y aborta como NEVER_PLAYED", async () => {
    const match = await seatPair(server, ["deal-z1", "deal-z2"]);
    const matchId = "m-deal-z1-deal-z2";

    await waitUntil(() => match.serverState.players.every((player) => player.hasAbandoned), 5_000);

    expect(linesOf(matchId).filter((line) => line === "SYSTEM ABANDON")).toHaveLength(2);
    expect(linesOf(matchId)).not.toContain("SYSTEM MATCH_RESOLVED");
    expect(match.serverState.phase).not.toBe("FINISHED");
    expect(match.serverState.activeDeadline).toBe(0);

    await server.getRoomById(match.roomId).disconnect();

    expect(historyOf(matchId).find((entry) => entry.type === "MATCH_ABORTED")).toMatchObject({
      source: "SYSTEM",
      kind: "EVENT",
      payload: { reason: "NEVER_PLAYED" },
    });
  }, 7_000);
});
