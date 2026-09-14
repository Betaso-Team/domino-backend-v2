import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Room } from "@colyseus/sdk";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { testConfig } from "../../../app.config.js";
import { rootContainer } from "../../../di-container.js";
import { env } from "../../../env.js";
import type { GlobalDominoConfig } from "../core/config.js";
import { boardEndsOf } from "../core/engine/round/board-ends.js";
import { playableSides } from "../core/engine/round/playable.js";
import type { MatchState } from "../core/state/index.js";
import type { BoardSide } from "../core/state/tile.js";
import type { HistoryEntry, HistoryReader } from "../network/history.js";
import { type DominoRoomOptions, configOf } from "../transports/match-contract.js";

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

// Puertos E2E reservados: lifecycle 2585, game-2p 2586, visibility 2587,
// concurrency 2588, reconnection 2589. Deal-window usará 2590 en la Tarea 23.
export async function bootServer(port: number): Promise<ColyseusTestServer> {
  return boot(testConfig, port);
}

// El predicado puede ser ASÍNCRONO, y no es generalidad gratis: desde que el lector del
// historial promete (`HistoryReader.of`), esperar a que aparezca una línea grabada —lo que
// hace deal-window-e2e con `linesOf`— es inexpresable con un predicado sincrónico. Los
// predicados que devuelven un booleano pelado siguen andando sin tocarlos: `await` sobre un
// no-thenable resuelve con el mismo valor.
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
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
  /** Las opciones con las que la sala se creó. Es de dónde sale el config real de la partida. */
  readonly options: DominoRoomOptions;
  readonly serverState: MatchState;
  readonly clients: Record<string, Awaited<ReturnType<ColyseusTestServer["connectTo"]>>>;
}

export async function seatPair(
  server: ColyseusTestServer,
  seats: [string, string],
  seed?: string,
): Promise<SeatedMatch> {
  const options = casualTable([...seats], seed);
  const room = await server.createRoom("domino", options);
  const clients: SeatedMatch["clients"] = {};
  for (const userId of seats) {
    server.sdk.auth.token = mintToken(userId);
    clients[userId] = await server.connectTo(room);
  }
  return { roomId: room.roomId, options, serverState: room.state as MatchState, clients };
}

// LA MESA ARRANCA TAPADA. `configOf` enciende la ventana de reparto en TODA mesa
// (es control de presencia anti-fraude), así que la ronda 1 nace en `DEALING` y las
// manos están ocultas incluso para su dueño hasta que él dice `REVEAL_TILES`. Todo
// test que quiera una ronda EN JUEGO pasa por acá; sin esto la espera se cuelga los
// el plazo de `dealingTimeoutMs` y termina retirando a los dos por no levantar las fichas.
export async function revealHands(match: SeatedMatch): Promise<void> {
  for (const client of Object.values(match.clients)) client.send("REVEAL_TILES", {});
  await waitUntil(() => match.serverState.currentRound?.phase === "PLAYING");
}

// El camino del que perdió su token: vuelve por roomId. El matchmaker admite este join
// porque `maxClients = seats.length * 2`; no verifica el `unlock()` de `onDrop`, pues con
// esa capacidad la sala no llega a lockearse durante la reserva.
//
// El `waitForInitialState()` no es adorno: `connectTo` del arnés de testing lo hace por
// dentro y `joinById` no. Sin él, `join()` resuelve con el handshake y el estado completo
// llega un viaje después, así que el llamador lee un `state` con los campos en `undefined`
// y no puede distinguir "todavía no llegó" de "la vista no me lo muestra" — que es
// justamente lo que este arnés existe para medir.
export async function rejoinAs(
  server: ColyseusTestServer,
  roomId: string,
  userId: string,
): Promise<Room<unknown, MatchState>> {
  server.sdk.auth.token = mintToken(userId);
  // El parámetro de tipo elige el overload que devuelve el estado tipado. Sin él,
  // `joinById` resuelve al de `State = any` y el llamador termina casteando `back.state`
  // en cada línea — casts que no verifican nada y que se quedarían mudos si el árbol
  // cambiara de forma.
  const room = await server.sdk.joinById<MatchState>(roomId);
  await room.waitForInitialState();
  return room;
}

// El cliente de un asiento, o un fallo con nombre. `SeatedMatch.clients` está indexado por
// string, así que leerlo devuelve `T | undefined`; el optional chaining convertiría un
// asiento mal escrito en un test que no hace nada.
export function clientOf(match: SeatedMatch, playerId: string): SeatedMatch["clients"][string] {
  const client = match.clients[playerId];
  if (!client) throw new Error(`sin cliente para el asiento ${playerId}`);
  return client;
}

export function turnHolderOf(match: SeatedMatch): string {
  const playerId = match.serverState.currentRound?.currentTurn?.playerId;
  if (!playerId) throw new Error("la ronda no tiene turno asignado");
  return playerId;
}

// La PRIMERA jugada legal del que la pide, ya en la forma del payload de `PLAY_TILE`.
// Devuelve `undefined` cuando no hay ninguna, que es el caso en que toca robar o pasar.
//
// El lado NO se puede hardcodear en "RIGHT" aunque el tablero esté vacío: que ahí funcione
// es una NORMALIZACIÓN de `playableSides` —con la cadena sin extremos, la primera ficha
// entra por un solo lado para que el mismo tablero no tenga dos representaciones—, no una
// regla del dominó. Derivarlo es lo que hace que el helper siga sirviendo en la jugada 2.
export function legalPlayFor(
  state: MatchState,
  playerId: string,
): { left: number; right: number; side: BoardSide } | undefined {
  const round = state.currentRound;
  if (!round) return undefined;
  const hand = state.players.find((player) => player.playerId === playerId)?.hand;
  if (!hand) return undefined;

  const ends = boardEndsOf(round.board);
  for (const tile of hand.tiles) {
    const side = playableSides(tile, ends).at(0);
    if (side) return { left: tile.left, right: tile.right, side };
  }
  return undefined;
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

// PROMETEN porque el puerto promete, no porque acá haya algo que esperar: en la suite el
// que está detrás del token es `MemoryHistory`, que resuelve con lo que ya tiene. El
// `await` en las aserciones es el precio de medir el MISMO contrato que usa producción —un
// helper sincrónico acá exigiría que el arnés resolviera la implementación concreta, que es
// el cast que `HistoryReader` vino a eliminar (ver network/history.ts).
export function historyOf(matchId: string): Promise<readonly HistoryEntry[]> {
  return rootContainer.resolve<HistoryReader>("HistoryReader").of(matchId);
}

export async function linesOf(matchId: string): Promise<string[]> {
  return (await historyOf(matchId)).map((entry) => `${entry.source} ${entry.type}`);
}

const GOLDEN_DIR = fileURLToPath(new URL("fixtures", import.meta.url));

// Captura una partida REAL entera —config, historial y árbol final— como fixture de
// regresión del replay. Nada se escribe a mano: el `meta` sale de las mismas opciones con
// las que la sala se creó y el `globalConfig` del mismo container, así que el fixture no
// puede describir una partida distinta de la que se jugó.
//
// `startedAt` viaja aparte porque NO está en el historial: `begin()` no emite nada, así
// que la primera entrada grabada es posterior al arranque. Sin él el replay inventa el
// instante y el árbol reconstruido difiere del real en ese campo.
//
// Solo escribe si se pide con WRITE_GOLDEN=1. En una corrida normal es no-op, así que el
// fixture no se regenera por accidente y una regresión no se auto-aprueba. El flag entra
// por `env`, nunca leyendo el entorno a mano: env.ts es el único lector permitido de la
// configuración del proceso, y env-single-reader.test.ts se pone rojo si alguien lo saltea
// —incluso escribiendo el nombre de esa variable global en un comentario como éste—.
export async function writeGolden(name: string, match: SeatedMatch): Promise<void> {
  if (!env.writeGolden) return;
  const meta = configOf(match.options);
  const payload = {
    meta,
    globalConfig: rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig"),
    startedAt: match.serverState.startedAt,
    entries: await historyOf(meta.matchId),
    finalState: match.serverState.toJSON(),
  };
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(`${GOLDEN_DIR}/${name}.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
