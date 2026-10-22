import { env } from "@/env";
import { fakeOrchestrator } from "@/tests/fake-orchestrator";
import { CASUAL_2P } from "@/tests/game-mode-catalog";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChargeRejectedError } from "../network/orchestrator-charges";
import {
  type SeatedMatch,
  act,
  bootServer,
  playUntilDecided,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

// EL REGISTRO v2.1 DE PUNTA A PUNTA: una partida jugada por la sala de verdad, leída por las rutas
// del panel y del backend principal. Lo que acá se mide y en ningún unitario es el CABLEADO: que la
// sala abra el registro con su `roomId` y el nombre del modo, que el cierre lleve lo que sólo la
// sala sabe —si el orquestador cobró— y que las tres rutas lean el mismo documento.
const PORT = 2620;
const base = `http://127.0.0.1:${PORT}`;
const KEY = { "x-internal-api-key": env.adminApiKey ?? "" };

type Doc = { readonly [key: string]: unknown };
type HeaderMap = { readonly [name: string]: string };
const get = (path: string, headers: HeaderMap = KEY) => fetch(`${base}${path}`, { headers });
const recordOf = async (matchId: string): Promise<Doc | undefined> => {
  const response = await get(`/internal/matches/${matchId}`);
  return response.status === 200 ? ((await response.json()) as { data: Doc }).data : undefined;
};
const closed = (record: Doc | undefined) =>
  record?.status === "finished" || record?.status === "aborted";

let server: ColyseusTestServer;
let played: SeatedMatch;

beforeAll(async () => {
  server = await bootServer(PORT);
  played = await seatPair(server, ["rec1", "rec2"], "seed-registro");
  await revealHands(played);
  await playUntilDecided(played);
  await waitUntil(async () => closed(await recordOf(played.config.matchId)), 3_000);
}, 30_000);

afterAll(async () => {
  await server.shutdown();
});

describe("el registro de una partida jugada", () => {
  it("abre con el armado de la mesa y cierra con el desenlace y la plata", async () => {
    const record = await recordOf(played.config.matchId);

    expect(record).toMatchObject({
      matchId: played.config.matchId,
      roomId: played.roomId,
      version: 2.1,
      status: "finished",
      matchEndReason: "SCORE",
      table: {
        gameModeId: CASUAL_2P.uuid,
        name: CASUAL_2P.name,
        entryFeeInUC: 125,
        prizeInUC: 250,
        isFree: false,
      },
      matchConfig: {
        playersQuantity: 2,
        pointsToWin: played.config.pointsToWin,
        seed: "seed-registro",
        teamAssignment: played.config.teamAssignment,
      },
      rateId: played.config.rateId,
    });
    expect(typeof record?._id).toBe("string");
    expect(record?.matchDurationInMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(String(record?.matchStartedAt))).toBe(played.serverState.startedAt);

    // EL QUE GANÓ COBRA EL PREMIO, los dos pagaron la entrada que el orquestador confirmó.
    const winnerTeamId = record?.winnerTeamId;
    const players = record?.players as Doc[];
    expect(players.map((player) => player.userId)).toEqual(["rec1", "rec2"]);
    for (const player of players) {
      expect(player).toMatchObject({
        chargedInUC: 125,
        prizePaidInUC: player.teamId === winnerTeamId ? 250 : 0,
      });
    }
    expect(record?.winnerIds).toEqual(
      players.filter((player) => player.teamId === winnerTeamId).map((player) => player.id),
    );
  });

  it("guarda cada mano cerrada y la timeline entera, con los instantes como fechas", async () => {
    const record = await recordOf(played.config.matchId);

    const rounds = record?.rounds as Doc[];
    expect(rounds.map((round) => round.roundNumber)).toEqual(
      played.serverState.pastRounds.map((round) => round.roundNumber),
    );
    expect(rounds[0]).toHaveProperty("starterId");
    const timeline = record?.timeline as Doc[];
    expect(timeline.map((entry) => entry.type)).toContain("MATCH_RESOLVED");
    expect(timeline[0]).toMatchObject({ type: "ROUND_STARTED" });
    expect(Number.isNaN(Date.parse(String(timeline[0]?.at)))).toBe(false);
  });

  it("aparece en el listado del panel, sin la timeline", async () => {
    const response = await get("/internal/matches?pageSize=100");
    const body = (await response.json()) as { data: { items: Doc[]; total: number } };

    const item = body.data.items.find((candidate) => candidate.matchId === played.config.matchId);
    expect(item).toMatchObject({
      roomId: played.roomId,
      game: "domino",
      status: "finished",
      matchEndReason: "SCORE",
    });
    expect(item).not.toHaveProperty("timeline");
  });

  it("`/game-data/:roomId` devuelve el mismo documento, sin `_id`", async () => {
    const response = await get(`/game-data/${played.roomId}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Doc;
    const { _id, ...detail } = (await recordOf(played.config.matchId)) ?? {};
    expect(body).toEqual(detail);
  });

  it("sin la llave del panel, las tres rutas son 401", async () => {
    for (const path of [
      "/internal/matches",
      `/internal/matches/${played.config.matchId}`,
      `/game-data/${played.roomId}`,
    ]) {
      expect((await get(path, {})).status).toBe(401);
    }
  });

  it("una partida que no está guardada es 404 en las dos", async () => {
    expect((await get("/internal/matches/no-existe")).status).toBe(404);
    const response = await get("/game-data/no-existe");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "MATCH_NOT_FOUND" });
  });
});

describe("el registro de las partidas que no terminan jugando", () => {
  // EL ORQUESTADOR NO COBRÓ: la mesa se cierra sin arrancar, así que el registro nace en el cierre y
  // trae el armado él mismo.
  it("sin cobro de entrada: abortada, sin arranque y sin plata", async () => {
    fakeOrchestrator.failEntryWith(async () =>
      Promise.reject(new ChargeRejectedError("INSUFFICIENT_FUNDS")),
    );
    try {
      const match = await seatPair(server, ["rec3", "rec4"]);
      await waitUntil(async () => closed(await recordOf(match.config.matchId)), 3_000);

      const record = await recordOf(match.config.matchId);
      expect(record).toMatchObject({
        status: "aborted",
        matchEndReason: "CHARGE_REJECTED",
        roomId: match.roomId,
        winnerIds: [],
        matchConfig: { seed: match.config.seed },
      });
      expect(record).not.toHaveProperty("matchStartedAt");
      expect((record?.players as Doc[]).map((player) => player.chargedInUC)).toEqual([0, 0]);
    } finally {
      fakeOrchestrator.failEntryWith(undefined);
    }
  });

  it("el que se va le da la partida al otro, y su salida queda en el registro", async () => {
    const match = await seatPair(server, ["rec5", "rec6"]);
    await revealHands(match);
    await act(match, "rec5", "ABANDON");
    await waitUntil(async () => closed(await recordOf(match.config.matchId)), 3_000);

    const record = await recordOf(match.config.matchId);
    expect(record).toMatchObject({ status: "finished", matchEndReason: "ABANDONMENT" });
    const [left, stayed] = record?.players as Doc[];
    expect(left).toMatchObject({ userId: "rec5", exit: { reason: "LEFT" }, prizePaidInUC: 0 });
    expect(stayed).toMatchObject({ userId: "rec6", prizePaidInUC: 250 });
    expect(stayed).not.toHaveProperty("exit");
    expect((record?.rounds as Doc[]).at(-1)).toMatchObject({ endReason: "MATCH_ABANDONED" });
  });
});
