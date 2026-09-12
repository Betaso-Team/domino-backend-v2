import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { testConfig } from "../../../app.config.js";
import { rootContainer } from "../../../di-container.js";
import { env } from "../../../env.js";
import type { MatchState } from "../core/state/index.js";
import type { HistoryEntry } from "../network/history.js";
import type { MemoryHistory } from "../network/transports/memory-history.js";
import type { DominoRoomOptions } from "../transports/match-contract.js";

export function mintToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { algorithm: "HS256", expiresIn: "1h" });
}

export function casualTable(seats: string[], seed = "seed-e2e"): DominoRoomOptions {
  return {
    mode: "CASUAL",
    matchId: `m-${seats.join("-")}`,
    gameModeId: "clasica-2p",
    seats,
    seed,
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
  };
}

export async function bootServer(port: number): Promise<ColyseusTestServer> {
  return boot(testConfig, port);
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: se agotó el plazo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function signatureOf(state: MatchState): string {
  return JSON.stringify([
    state.phase,
    state.activeDeadline,
    state.currentRound?.phase ?? null,
    state.currentRound?.roundNumber ?? null,
    state.currentRound?.currentTurn?.playerId ?? null,
    state.currentRound?.board.tiles.length ?? null,
    state.currentRound?.boneyard?.count ?? null,
    state.scoreboard?.teamA ?? null,
    state.scoreboard?.teamB ?? null,
    state.players.map((player) => [player.hand.tileCount, player.hasAbandoned, player.connected]),
  ]);
}

export interface SeatedMatch {
  readonly roomId: string;
  readonly serverState: MatchState;
  readonly clients: Record<string, Awaited<ReturnType<ColyseusTestServer["connectTo"]>>>;
}

export async function seatPair(
  server: ColyseusTestServer,
  seats: [string, string],
  seed?: string,
): Promise<SeatedMatch> {
  const room = await server.createRoom("domino", casualTable([...seats], seed));
  const clients: SeatedMatch["clients"] = {};
  for (const userId of seats) {
    server.sdk.auth.token = mintToken(userId);
    clients[userId] = await server.connectTo(room);
  }
  return { roomId: room.roomId, serverState: room.state as MatchState, clients };
}

export async function act(
  match: SeatedMatch,
  userId: string,
  type: string,
  payload: unknown = {},
): Promise<void> {
  const before = signatureOf(match.serverState);
  match.clients[userId]?.send(type, payload);
  await waitUntil(() => signatureOf(match.serverState) !== before);
}

export function historyOf(matchId: string): readonly HistoryEntry[] {
  return (rootContainer.resolve("HistoryPort") as MemoryHistory).of(matchId);
}

export function linesOf(matchId: string): string[] {
  return historyOf(matchId).map((entry) => `${entry.source} ${entry.type}`);
}
