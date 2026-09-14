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

// LA MESA ARRANCA TAPADA. `configOf` enciende la ventana de reparto en TODA mesa
// (es control de presencia anti-fraude), así que la ronda 1 nace en `DEALING` y las
// manos están ocultas incluso para su dueño hasta que él dice `REVEAL_TILES`. Todo
// test que quiera una ronda EN JUEGO pasa por acá; sin esto la espera se cuelga los
// 15 s de `dealingTimeoutMs` —el único plazo que no es configurable por entorno— y
// termina retirando a los dos por no levantar las fichas.
export async function revealHands(match: SeatedMatch): Promise<void> {
  for (const client of Object.values(match.clients)) client.send("REVEAL_TILES", {});
  await waitUntil(() => match.serverState.currentRound?.phase === "PLAYING");
}

// El camino del que perdió su token: vuelve por roomId. Es lo que verifica que el
// unlock() de onDrop funciona — sin él, el matchmaker rechaza este join porque la
// sala cuenta el asiento reservado.
//
// El `waitForInitialState()` no es adorno: `connectTo` del arnés de testing lo hace por
// dentro y `joinById` no. Sin él, `join()` resuelve con el handshake y el estado completo
// llega un viaje después, así que el llamador lee un `state` con los campos en `undefined`
// y no puede distinguir "todavía no llegó" de "la vista no me lo muestra" — que es
// justamente lo que este arnés existe para medir.
export async function rejoinAs(server: ColyseusTestServer, roomId: string, userId: string) {
  server.sdk.auth.token = mintToken(userId);
  const room = await server.sdk.joinById(roomId);
  await room.waitForInitialState();
  return room;
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
