import { env } from "@/env";
import { findBadAmounts } from "@/shared/tests/find-bad-amounts";
import { mintAdminToken } from "@/tests/billing-auth-keys";
import { fakeOrchestrator } from "@/tests/fake-orchestrator";
import { CASUAL_2P } from "@/tests/table-modes";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChargeRejectedError } from "../network/orchestrator-charges";
import {
  type SeatedMatch,
  act,
  bootServer,
  mintToken,
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
        name: CASUAL_2P.gameMode.name,
        // EN LA CONVENCIÓN DE MONTOS: Mongo guarda `entryFeeInUC`, el panel lee la mesa en UC.
        currency: "UC",
        entryFee: "125.0000",
        prize: "250.0000",
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
      // SIN PRECIO, CADA ASIENTO EN UC, con la tasa de la partida.
      expect(player).toMatchObject({
        currency: "UC",
        rateId: played.config.rateId,
        charged: "125.0000",
        prizePaid: player.teamId === winnerTeamId ? "250.0000" : "0.0000",
      });
    }
    expect(findBadAmounts(record, ["entryFee", "prize", "entry", "charged", "prizePaid"])).toEqual(
      [],
    );
    expect(JSON.stringify(record)).not.toContain('"uc"');
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
    expect(await response.json()).toEqual({ code: "MATCH_NOT_FOUND" });
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
      expect((record?.players as Doc[]).map((player) => player.charged)).toEqual([
        "0.0000",
        "0.0000",
      ]);
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
    expect(left).toMatchObject({
      userId: "rec5",
      exit: { reason: "LEFT" },
      currency: "UC",
      prizePaid: "0.0000",
    });
    expect(stayed).toMatchObject({ userId: "rec6", currency: "UC", prizePaid: "250.0000" });
    expect(stayed).not.toHaveProperty("exit");
    expect((record?.rounds as Doc[]).at(-1)).toMatchObject({ endReason: "MATCH_ABANDONED" });
  });
});

// EL PRECIO EN LA MONEDA DE CADA UNO, de la mesa al historial del jugador: la sala lo congela en el
// asiento, el cierre elige lo cobrado y lo pagado, y `GET /me/matches` lo devuelve tal cual quedó.
describe("el registro y el historial en la moneda del jugador", () => {
  const price = {
    currency: "VES",
    rate: "200",
    entry: "25000.00",
    prize: "50000.00",
    levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
  };

  it("el asiento con precio lo guarda, y su fila lo devuelve; el que no lo trajo queda en UC", async () => {
    const match = await seatPair(server, [
      { userId: "rec7", displayName: "Siete", currency: "VES", price },
      { userId: "rec8", displayName: "Ocho", currency: "VES" },
    ]);
    await revealHands(match);
    await act(match, "rec8", "ABANDON");
    await waitUntil(async () => closed(await recordOf(match.config.matchId)), 3_000);

    const record = await recordOf(match.config.matchId);
    const [priced, plain] = record?.players as Doc[];
    // EL PANEL LO LEE EN LA CONVENCIÓN: el asiento con precio es una entidad en su moneda, con la tasa
    // de la partida, y lo cobrado y lo pagado salen de `*InPlayerCurrency`; el que no lo trajo, en UC.
    expect(priced).toMatchObject({
      currency: "VES",
      rateId: match.config.rateId,
      userId: "rec7",
      price: {
        currency: "VES",
        rateId: match.config.rateId,
        rate: "200",
        entry: "25000.00",
        prize: "50000.00",
        levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
      },
      charged: "25000.00",
      prizePaid: "50000.00",
    });
    expect(priced).not.toHaveProperty("chargedInPlayerCurrency");
    expect(plain).not.toHaveProperty("price");
    expect(plain).toMatchObject({ currency: "UC", charged: "125.0000", prizePaid: "0.0000" });

    const rowOf = async (userId: string) => {
      const response = await fetch(`${base}/me/matches`, {
        headers: { authorization: `Bearer ${mintToken(userId)}` },
      });
      const page = (await response.json()) as { items: Doc[] };
      return page.items.find((item) => item.id === match.config.matchId);
    };
    // LA FILA EN LA CONVENCIÓN DE MONTOS: en la moneda del precio, o en UC si el asiento no lo trajo.
    expect(await rowOf("rec7")).toMatchObject({
      result: "win",
      currency: "VES",
      bet: "25000.00",
      prize: "50000.00",
    });
    expect(await rowOf("rec8")).toMatchObject({
      result: "abandoned",
      currency: "UC",
      bet: "125.0000",
      prize: "0.0000",
    });
  });
});

// EL PROVEEDOR DE CADA ASIENTO, del pedido del orquestador al registro y al panel: la sala lo congela en
// el asiento, el registro lo guarda en `seats[]` y en `players[]`, y un admin de ese proveedor ve la
// partida en el listado y en el detalle.
describe("el registro por proveedor", () => {
  it("el asiento guarda su proveedor, y el admin de ese proveedor ve la partida", async () => {
    const match = await seatPair(server, [
      { userId: "rec9", displayName: "Nueve", currency: "VES", providerId: "betaso" },
      { userId: "rec10", displayName: "Diez", currency: "VES" },
    ]);
    await revealHands(match);
    await act(match, "rec10", "ABANDON");
    await waitUntil(async () => closed(await recordOf(match.config.matchId)), 3_000);

    const record = await recordOf(match.config.matchId);
    for (const field of ["seats", "players"] as const) {
      const [provided, plain] = record?.[field] as Doc[];
      expect(provided).toMatchObject({ userId: "rec9", providerId: "betaso" });
      expect(plain).not.toHaveProperty("providerId");
    }

    const as = (prv: string) => ({
      authorization: `Bearer ${mintAdminToken("pia", { prv, role: "support" })}`,
    });
    const listed = async (prv: string) => {
      const response = await get("/internal/matches?pageSize=100", as(prv));
      const body = (await response.json()) as { data: { items: Doc[] } };
      return body.data.items.map((item) => item.matchId);
    };
    expect(await listed("betaso")).toEqual([match.config.matchId]);
    expect(await listed("parley")).toEqual([]);
    expect((await get(`/internal/matches/${match.config.matchId}`, as("betaso"))).status).toBe(200);
    expect((await get(`/internal/matches/${match.config.matchId}`, as("parley"))).status).toBe(404);
  });
});

// EL MODO EN LÍNEA: el orquestador manda el modo con el que cobró, y el registro nombra la mesa con
// `gameModeId` y `gameMode.name` y la cobra con sus importes, no con los del modo de la suite.
describe("el registro de una mesa con el modo en línea", () => {
  it("lleva el nombre y los importes del modo del pedido", async () => {
    const gameModeId = "00000000-0000-4000-8000-00000000c4c4";
    const match = await seatPair(server, ["rec11", "rec12"], "seed-en-linea", {
      gameModeId,
      gameMode: {
        name: "Modo del orquestador",
        playersQuantity: 2,
        pointsToWin: 60,
        multiplier: 2,
        entryFee: 3,
        prize: 5,
        isFreeRoom: false,
        enableBots: false,
      },
    });
    await revealHands(match);
    await act(match, "rec11", "ABANDON");
    await waitUntil(async () => closed(await recordOf(match.config.matchId)), 3_000);

    const record = await recordOf(match.config.matchId);
    expect(record).toMatchObject({
      status: "finished",
      table: {
        gameModeId,
        name: "Modo del orquestador",
        currency: "UC",
        entryFee: "3.0000",
        prize: "5.0000",
      },
      matchConfig: { pointsToWin: 60 },
    });
    const [, stayed] = record?.players as Doc[];
    expect(stayed).toMatchObject({
      userId: "rec12",
      currency: "UC",
      charged: "3.0000",
      prizePaid: "5.0000",
    });
  });
});
