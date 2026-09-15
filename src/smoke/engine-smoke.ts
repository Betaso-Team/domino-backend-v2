import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { ColyseusSDK, type Room } from "@colyseus/sdk";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import type { DominoMatchConfig } from "../features/match/core/config.js";
import { createMatchState } from "../features/match/core/engine/genesis.js";
import { boardEndsOf } from "../features/match/core/engine/round/board-ends.js";
import { playableSides } from "../features/match/core/engine/round/playable.js";
import { boneyardCountOf } from "../features/match/core/engine/state-projections.js";
import { MatchState } from "../features/match/core/state/index.js";
import type { BoardSide } from "../features/match/core/state/tile.js";
import { settlementOf } from "../features/match/index.js";
import { type DominoRoomOptions, configOf } from "../features/match/transports/match-contract.js";
import { logger } from "../logger.js";

const WS_URL = "ws://nginx:8080";
const HTTP_URL = "http://nginx:8080";
const OPTIONS = {
  mode: "CASUAL",
  matchId: "smoke-full-game",
  gameModeId: "classic-2p",
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
  pointsToWin: 30,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} satisfies DominoRoomOptions;

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
        amountUcMinor: config.prizeUcMinor,
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
    refund?.entries.map(({ platformId, currency, amountUcMinor }) => ({
      platformId,
      currency,
      amountUcMinor,
    })),
    [
      { platformId: "betaso", currency: "VES", amountUcMinor: 125 },
      { platformId: "partner", currency: "USD", amountUcMinor: 125 },
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

async function run(): Promise<void> {
  requireSmokeFlag(env.runEngineSmoke);
  await Promise.all([
    waitUntil("ready de 2567", () => isReady(2567), 30_000),
    waitUntil("ready de 2568", () => isReady(2568), 30_000),
  ]);

  const config = configOf(OPTIONS);
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
  void run().catch((error: unknown) => {
    logger.error("smoke fallido", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  });
}
