import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rootContainer } from "@/di-container";
import { env } from "@/env";
import {
  type ParticipantInput,
  bootTestServer,
  casualTable,
  mintToken,
  participantOf,
  waitUntil,
} from "@/tests/e2e";
import { CASUAL_2P } from "@/tests/game-mode-catalog";
import type { Room } from "@colyseus/sdk";
import type { ColyseusTestServer } from "@colyseus/testing";
import type { DominoMatchConfig, GlobalDominoConfig } from "../core/config";
import { boardEndsOf } from "../core/rules/board-ends";
import { playableSides } from "../core/rules/playable";
import type { MatchState } from "../core/state";
import type { BoardSide } from "../core/state/tile";
import type { HistoryEntry, HistoryReader } from "../network/history";
import { type CreateMatchRequest, configOf, requestOf } from "../transports/match-contract";

export {
  bootTestServer as bootServer,
  casualTable,
  mintToken,
  participantOf,
  type ParticipantInput,
  waitUntil,
};

// Puertos E2E reservados: lifecycle 2585, game-2p 2586, visibility 2587,
// concurrency 2588, reconnection 2589, deal-window 2590. Fuera de esta carpeta,
// `src/tests/http-root-route.e2e.test.ts` levanta su propio servidor en el 2591.
// El predicado puede ser ASÍNCRONO, y no es generalidad gratis: desde que el lector del
// historial promete (`HistoryReader.of`), esperar a que aparezca una línea grabada —lo que
// hace deal-window.e2e con `linesOf`— es inexpresable con un predicado sincrónico. Los
// predicados que devuelven un booleano pelado siguen andando sin tocarlos: `await` sobre un
// no-thenable resuelve con el mismo valor.
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
  /** El request con el que la sala se creó. Es la mitad viva del config; la otra es el modo. */
  readonly options: CreateMatchRequest;
  /**
   * El MISMO snapshot que la sala normalizó: es lo único que traduce entre el `userId`
   * con el que el test nombra a un jugador y el `seat-N` con el que el servidor lo nombra.
   * Sin él, cada test tendría que saber en qué posición lo sentó `configOf`.
   */
  readonly config: DominoMatchConfig;
  readonly serverState: MatchState;
  /** Indexado por el id OPACO del asiento, que es el que el servidor usa. */
  readonly clients: Record<string, Awaited<ReturnType<ColyseusTestServer["connectTo"]>>>;
}

export async function seatPair(
  server: ColyseusTestServer,
  seats: readonly [ParticipantInput, ParticipantInput],
  seed?: string,
): Promise<SeatedMatch> {
  const options = casualTable(seats, seed);
  // EL MISMO PAR QUE LA SALA: el request validado y el modo sembrado. Si acá se armara el config a
  // mano, el arnés describiría una mesa distinta de la que el servidor creó y los `seat-N` con los
  // que los tests hablan podrían no ser los suyos.
  const config = configOf(requestOf(options), CASUAL_2P);
  const room = await server.createRoom("domino", options);
  const clients: SeatedMatch["clients"] = {};
  for (const seat of config.seats) {
    server.sdk.auth.token = mintToken(seat);
    clients[seat.playerId] = await server.connectTo(room);
  }
  return { roomId: room.roomId, options, config, serverState: room.state as MatchState, clients };
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
  match: SeatedMatch,
  selector: string,
): Promise<Room<unknown, MatchState>> {
  const playerId = playerIdOf(match, selector);
  const seat = match.config.seats.find((candidate) => candidate.playerId === playerId);
  if (!seat) throw new Error(`sin asiento para ${playerId}`);
  // EL TOKEN SE FIRMA CON LA IDENTIDAD DEL ASIENTO, no con el selector: un test que entró por
  // `seat-1` tiene que volver como la misma persona, y `seat-1` no es un `sub` que se pueda
  // firmar.
  server.sdk.auth.token = mintToken(seat);
  // El parámetro de tipo elige el overload que devuelve el estado tipado. Sin él,
  // `joinById` resuelve al de `State = any` y el llamador termina casteando `back.state`
  // en cada línea — casts que no verifican nada y que se quedarían mudos si el árbol
  // cambiara de forma.
  const room = await server.sdk.joinById<MatchState>(match.roomId);
  await room.waitForInitialState();
  return room;
}

// EL ÚNICO RESOLVEDOR de "a quién se refiere este test". Acepta el id opaco del asiento
// —que es lo que el servidor devuelve en `currentTurn.playerId`— y también el `userId` o
// el `userId`, que es como los tests nombran a la gente. Sin esto, cada suite tendría que
// saber que `configOf` sienta al primer participante en `seat-1`.
//
// El selector acepta las DOS formas y las distingue probando primero el `playerId`: desde que
// la identidad se aplanó a `userId` los dos son `string`, así que ya no hay tipo que los
// separe. No es ambiguo igual — `configOf` reparte `seat-N` y ningún `userId` de la suite
// tiene esa forma.
export function playerIdOf(match: SeatedMatch, selector: string): string {
  const direct = match.config.seats.find(({ playerId }) => playerId === selector);
  if (direct) return direct.playerId;
  // Un solo chequeo para los dos casos: el resto vacío dice "no es ambiguo" y `seat` presente
  // dice "existe" — que es además lo que `noUncheckedIndexedAccess` necesita para estrechar.
  const [seat, ...ambiguous] = match.config.seats.filter(({ userId }) => userId === selector);
  if (!seat || ambiguous.length > 0) throw new Error(`selector ambiguo o ausente: ${selector}`);
  return seat.playerId;
}

// El cliente de un asiento, o un fallo con nombre. `SeatedMatch.clients` está indexado por
// string, así que leerlo devuelve `T | undefined`; el optional chaining convertiría un
// asiento mal escrito en un test que no hace nada.
export function clientOf(match: SeatedMatch, selector: string): SeatedMatch["clients"][string] {
  const playerId = playerIdOf(match, selector);
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
  selector: string,
  type: string,
  payload: unknown = {},
): Promise<void> {
  const before = signatureOf(match.serverState);
  clientOf(match, selector).send(type, payload);
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
  // EL SNAPSHOT QUE LA SALA USÓ, no uno recalculado: desde la Tarea 10 el config depende del modo
  // que el catálogo resolvió, y volver a armarlo acá sería una segunda oportunidad de armarlo
  // distinto. `match.config` es exactamente el par (request, modo) que `seatPair` cruzó.
  //
  // OJO AL REGENERAR: `meta.gameModeId` es el uuid que el catálogo de ESA corrida generó, así que
  // cambia en cada regeneración como los instantes. El motor no lo lee —`replay()` lo ignora—, así
  // que es ruido del diff y no una diferencia de la partida.
  const meta = match.config;
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
