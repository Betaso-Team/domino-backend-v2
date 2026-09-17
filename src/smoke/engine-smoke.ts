import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { env } from "@/env.js";
import type { GameMode } from "@/features/game-mode/index.js";
import type { DominoMatchConfig } from "@/features/match/core/config.js";
import { createMatchState } from "@/features/match/core/engine/genesis.js";
import { boneyardCountOf } from "@/features/match/core/engine/state-projections.js";
import { boardEndsOf } from "@/features/match/core/rules/board-ends.js";
import { playableSides } from "@/features/match/core/rules/playable.js";
import { MatchState } from "@/features/match/core/state/index.js";
import type { BoardSide } from "@/features/match/core/state/tile.js";
import { settlementOf } from "@/features/match/index.js";
import {
  type CreateMatchRequest,
  configOf,
  requestOf,
} from "@/features/match/transports/match-contract.js";
import { logger } from "@/logger.js";
import { ColyseusSDK, type Room } from "@colyseus/sdk";
import jwt from "jsonwebtoken";

const WS_URL = "ws://nginx:8080";
const HTTP_URL = "http://nginx:8080";

// EL MODO QUE EL SMOKE CONFIGURA, y desde la Tarea 10 es de dónde salen los puntos y el dinero de
// la mesa: el request ya no los puede declarar. Se crea POR HTTP contra el servidor real y no se
// escribe en el proceso del smoke — el punto entero del smoke es que el servidor resuelva su
// propio catálogo—. `pointsToWin: 30` es lo que hace que la partida termine en un tiempo razonable.
const MODE_INPUT = {
  name: "smoke-2p",
  playersQuantity: 2,
  pointsToWin: 30,
  entryFee: 125,
  prize: 250,
} as const;

// El DTO de v1, recortado a lo que el smoke necesita: `configOf` sólo lee `uuid`,
// `playersQuantity`, `pointsToWin`, `entryFee` y `prize`. Se declara acá porque la superficie del
// catálogo exporta la ENTIDAD y no su representación HTTP, que es del panel.
interface GameModeDTO {
  readonly _id: string;
  readonly uuid: string;
  readonly name: string;
  readonly multiplier: number;
  readonly prize: number;
  readonly entryFee: number;
  readonly playersQuantity: 2 | 4;
  readonly pointsToWin: number;
  readonly isActive: boolean;
  readonly isFreeRoom: boolean;
  readonly enableBots: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly __v: number;
}

const requestFor = (gameModeId: string) =>
  ({
    mode: "CASUAL",
    matchId: "smoke-full-game",
    gameModeId,
    participants: [
      {
        platformId: "betaso",
        userUuid: "shared-smoke-uuid",
        displayName: "Ada",
        currency: "VES",
      },
      {
        platformId: "partner",
        userUuid: "shared-smoke-uuid",
        displayName: "Lin",
        currency: "USD",
      },
    ],
    seed: "smoke-deterministic-seed",
    teamAssignment: "SEAT_ORDER",
    rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  }) satisfies CreateMatchRequest;

type SmokeRoom = Room<unknown, MatchState>;

export function requireSmokeFlag(enabled: boolean): void {
  if (!enabled) throw new Error("el smoke requiere RUN_ENGINE_SMOKE=1");
}

export type SmokeAction =
  | {
      readonly type: "PLAY_TILE";
      readonly payload: { left: number; right: number; side: BoardSide };
    }
  | { readonly type: "DRAW_TILE"; readonly payload: Record<string, never> }
  | { readonly type: "PASS"; readonly payload: Record<string, never> };

export function nextAction(state: MatchState, playerId: string): SmokeAction | undefined {
  const round = state.currentRound;
  if (!round || round.phase !== "PLAYING") return undefined;
  const hand = state.players.find((player) => player.playerId === playerId)?.hand;
  if (!hand) throw new Error(`sin mano visible para ${playerId}`);
  const ends = boardEndsOf(round.board);
  for (const tile of hand.tiles) {
    const side = playableSides(tile, ends).at(0);
    if (side) return { type: "PLAY_TILE", payload: { left: tile.left, right: tile.right, side } };
  }
  return boneyardCountOf(round) > 0
    ? { type: "DRAW_TILE", payload: {} }
    : { type: "PASS", payload: {} };
}

async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${label}: se agotó el plazo${detail}`);
}

const tokenOf = (platformId: string, userUuid: string) =>
  jwt.sign({ sub: userUuid, platformId }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "10m",
  });

const signatureOf = (state: MatchState) =>
  JSON.stringify([
    state.phase,
    state.activeDeadline,
    state.currentRound?.phase,
    state.currentRound?.roundNumber,
    state.currentRound?.currentTurn?.playerId,
    state.currentRound?.board.tiles.map(({ tile, side }) => [tile.left, tile.right, side]),
    state.currentRound?.boneyard?.count,
    state.players.map(({ playerId, hand }) => [playerId, hand.tileCount]),
  ]);

const isReady = async (port: number) => {
  const response = await fetch(`${HTTP_URL}/${port}/ready`);
  return response.status === 200;
};

interface HistoryLine {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

async function historyOf(matchId: string): Promise<readonly HistoryLine[]> {
  assert.ok(env.internalApiKey, "falta INTERNAL_API_KEY en el cliente smoke");
  const response = await fetch(`${HTTP_URL}/internal/matches/${matchId}/history`, {
    headers: { "X-Internal-Key": env.internalApiKey },
  });
  if (response.status !== 200) return [];
  const body = (await response.json()) as { entries?: readonly HistoryLine[] };
  return body.entries ?? [];
}

function assertSettlements(
  history: readonly HistoryLine[],
  state: MatchState,
  config: DominoMatchConfig,
): void {
  const line = history.find(({ type }) => type === "MATCH_RESOLVED");
  assert.ok(line, "historial sin MATCH_RESOLVED");
  const winnerTeamId = line.payload.winnerTeamId;
  const reason = line.payload.reason;
  assert.ok(winnerTeamId === "A" || winnerTeamId === "B", "winnerTeamId inválido");
  assert.equal(reason, "SCORE", "el smoke terminó sin jugar hasta el puntaje");

  const settlementState = createMatchState(config);
  for (const player of settlementState.players) {
    const deployed = state.players.find(({ playerId }) => playerId === player.playerId);
    assert.ok(deployed, `el deploy no devolvió ${player.playerId}`);
    player.teamId = deployed.teamId;
  }

  const reward = settlementOf(
    { type: "MATCH_RESOLVED", winnerTeamId, reason },
    settlementState,
    config,
  );
  const winnerId = state.players.find(({ teamId }) => teamId === winnerTeamId)?.playerId;
  const winner = config.seats.find(({ playerId }) => playerId === winnerId);
  assert.ok(winner, "config sin asiento ganador");
  assert.deepEqual(reward, {
    matchId: config.matchId,
    rateId: config.rateId,
    kind: "REWARD",
    entries: [
      {
        platformId: winner.platformId,
        userUuid: winner.userUuid,
        currency: winner.currency,
        amount: config.prize,
        idempotencyKey: `["${config.matchId}","REWARD","${winner.platformId}","${winner.userUuid}"]`,
      },
    ],
  });

  const refund = settlementOf(
    { type: "MATCH_ABORTED", reason: "INTERRUPTED" },
    settlementState,
    config,
  );
  assert.equal(refund?.kind, "REFUND");
  assert.deepEqual(
    refund?.entries.map(({ platformId, currency, amount }) => ({
      platformId,
      currency,
      amount,
    })),
    [
      { platformId: "betaso", currency: "VES", amount: 125 },
      { platformId: "partner", currency: "USD", amount: 125 },
    ],
  );
}

async function play(roomA: SmokeRoom, roomB: SmokeRoom, config: DominoMatchConfig) {
  const byPlayerId = new Map([
    [config.seats[0]?.playerId, roomA],
    [config.seats[1]?.playerId, roomB],
  ]);
  const recentActions: string[] = [];
  for (let turn = 0; turn < 3_000 && roomA.state.phase !== "FINISHED"; turn += 1) {
    const before = signatureOf(roomA.state);
    const playerId = roomA.state.currentRound?.currentTurn?.playerId;
    if (roomA.state.currentRound?.phase === "PLAYING" && playerId) {
      const owner = byPlayerId.get(playerId);
      if (!owner) throw new Error(`turno de asiento desconocido: ${playerId}`);
      await waitUntil(
        `la vista de ${playerId} no alcanzó al árbitro`,
        () => signatureOf(owner.state) === before,
        1_000,
      );
      const action = nextAction(owner.state, playerId);
      if (!action) throw new Error(`sin acción para ${playerId}`);
      recentActions.push(`${playerId} ${action.type}`);
      if (recentActions.length > 20) recentActions.shift();
      owner.send(action.type, action.payload);
    }
    await waitUntil("el estado no avanzó", () => signatureOf(roomA.state) !== before, 5_000);
  }
  assert.equal(
    roomA.state.phase,
    "FINISHED",
    `la partida no terminó; últimas acciones: ${recentActions.join(", ")}`,
  );
}

// CREA EL MODO CONTRA EL SERVIDOR REAL, con la llave interna: el catálogo es administrativo y sus
// mutaciones no son públicas. Se afirma el 201 en vez de tolerar el 409 del duplicado a propósito —
// el smoke corre contra un compose recién levantado (`down -v` entre corridas), así que un modo ya
// existente significa que el entorno no está limpio, y eso es un fallo que conviene ver acá y no
// tres aserciones más adelante.
//
// ⛔ ESTO TODAVÍA NO PUEDE CONTESTAR 201: la Tarea 11 es la que registra `registerGameModeHttp` en
// `src/app.config.ts` y la 12 la que arma las fases del compose que ejercitan este archivo. Queda
// escrito acá porque es el llamador que justifica ese cableado, y porque el smoke sin esta llamada
// no describiría el sistema que la Tarea 10 acaba de construir.
async function createGameMode(): Promise<GameMode> {
  const response = await fetch(`${HTTP_URL}/game-modes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Key": env.internalApiKey ?? "" },
    body: JSON.stringify(MODE_INPUT),
  });
  assert.equal(
    response.status,
    201,
    `el catálogo no creó el modo del smoke: HTTP ${response.status}`,
  );
  const { data } = (await response.json()) as { data: GameModeDTO };
  // El DTO de v1 nombra `_id` y `__v` lo que la entidad llama `id` y `version`: el mapeo va acá y
  // no se saltea, porque `configOf` recibe la ENTIDAD y no la representación del panel.
  return {
    id: data._id,
    uuid: data.uuid,
    name: data.name,
    multiplier: data.multiplier,
    prize: data.prize,
    entryFee: data.entryFee,
    playersQuantity: data.playersQuantity,
    pointsToWin: data.pointsToWin,
    isActive: data.isActive,
    isFreeRoom: data.isFreeRoom,
    enableBots: data.enableBots,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
    version: data.__v,
  };
}

async function run(): Promise<void> {
  requireSmokeFlag(env.runEngineSmoke);
  await Promise.all([
    waitUntil("ready de 2567", () => isReady(2567), 30_000),
    waitUntil("ready de 2568", () => isReady(2568), 30_000),
  ]);

  // EL MODO SE CREA ANTES QUE LA SALA, y esa es la mitad nueva de esta corrida: el servidor
  // resuelve el catálogo en `onCreate`, así que sin este POST ninguna mesa llega a existir.
  const mode = await createGameMode();
  const OPTIONS = requestFor(mode.uuid);
  // EL MISMO PAR QUE EL SERVIDOR CRUZÓ. El smoke necesita el snapshot local para saber qué asiento
  // es cada uno y para proyectar la liquidación; armarlo con el modo que el catálogo devolvió es
  // lo que garantiza que sea el mismo que la sala congeló.
  const config = configOf(requestOf(OPTIONS), mode);
  const sdkA = new ColyseusSDK(WS_URL);
  const sdkB = new ColyseusSDK(WS_URL);
  sdkA.auth.token = tokenOf("betaso", "shared-smoke-uuid");
  sdkB.auth.token = tokenOf("partner", "shared-smoke-uuid");
  let roomA: SmokeRoom | undefined;
  let roomB: SmokeRoom | undefined;
  try {
    const first = await sdkA.create<MatchState>("domino", OPTIONS, MatchState);
    roomA = first;
    const second = await sdkB.joinById<MatchState>(first.roomId, {}, MatchState);
    roomB = second;
    await waitUntil(
      "estado inicial de ambos clientes",
      () => first.state.players.length === 2 && second.state.players.length === 2,
    );

    const outsider = new ColyseusSDK(WS_URL);
    outsider.auth.token = tokenOf("third", "shared-smoke-uuid");
    await assert.rejects(outsider.joinById(first.roomId, {}, MatchState));

    const wire = JSON.stringify(first.state.toJSON());
    assert.match(wire, /Ada/);
    assert.match(wire, /Lin/);
    for (const privateValue of ["shared-smoke-uuid", "betaso", "partner", "VES", "USD"]) {
      assert.equal(wire.includes(privateValue), false, `dato privado filtrado: ${privateValue}`);
    }

    first.send("REVEAL_TILES", {});
    second.send("REVEAL_TILES", {});
    await waitUntil(
      "reparto visible para sus dueños",
      () =>
        first.state.currentRound?.phase === "PLAYING" &&
        second.state.currentRound?.phase === "PLAYING" &&
        first.state.players.find(({ playerId }) => playerId === "seat-1")?.hand.tiles.length ===
          7 &&
        second.state.players.find(({ playerId }) => playerId === "seat-2")?.hand.tiles.length === 7,
    );

    await play(first, second, config);
    let history: readonly HistoryLine[] = [];
    await waitUntil("historial terminal", async () => {
      history = await historyOf(config.matchId);
      return history.some(({ type }) => type === "MATCH_RESOLVED");
    });
    assertSettlements(history, first.state, config);
    logger.info("smoke completo", { matchId: config.matchId, history: history.length });
  } finally {
    await Promise.allSettled([roomA?.leave(), roomB?.leave()]);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void run()
    .catch((error: unknown) => {
      logger.error("smoke fallido", {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exitCode = 1;
    })
    // ⚠ SE SALE EXPLÍCITAMENTE, y esto lo encontró la primera corrida real de la Tarea 12: el
    // trabajo terminaba bien —«smoke completo» con 119 entradas de historial— y el proceso NO
    // salía nunca. El SDK de Colyseus deja handles vivos después del `leave()` (el `outsider` que
    // se rechaza, y sockets que siguen recibiendo `events`), así que el event loop no se vacía
    // solo. Antes lo tapaba el `--abort-on-container-exit` del runner viejo, que mataba el stack
    // entero apenas un contenedor salía; el runner de la Tarea 12 ESPERA a cada fase, así que el
    // cuelgue quedó a la vista — colgado 56 minutos, en verde, sin decir nada.
    //
    // Un CLI que terminó su trabajo tiene que salir. Los logs de pino van a stdout de forma
    // síncrona, así que no hay nada en vuelo que truncar.
    .finally(() => process.exit(process.exitCode ?? 0));
}
