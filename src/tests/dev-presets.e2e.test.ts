import { env } from "@/env";
import { SETTINGS_ROUTE } from "@/features/settings";
import { bootTestServer, casualTable, joinAs, waitUntil } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// LAS DOS HERRAMIENTAS DE PRUEBA A MANO, de punta a punta: el parche por HTTP y la mesa siguiente que
// nace con él. La suite corre como `local`, que es uno de los dos entornos donde existen; que en stage
// y prod NO existan lo decide `isDevEnvironment`, medido en `src/env.test.ts` —el mismo criterio que
// el playground y el monitor—. Portado de truco (`d6e3219`, `6da7372`).
const PORT = 2614;
const admin = {
  "Content-Type": "application/json",
  "x-internal-api-key": env.adminPanelApiKey ?? "",
};
const section = (name: string, init: RequestInit) =>
  fetch(`http://127.0.0.1:${PORT}${SETTINGS_ROUTE}/${name}`, { headers: admin, ...init });

type ServerState = {
  activeDeadline: number;
  scoreboard: { teamA: number; teamB: number };
  players: { playerId: string; hand: { tiles: { left: number; right: number }[] } }[];
};

describe("El reparto preparado y el marcador inicial (local y dev)", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterEach(async () => {
    await section("deal", { method: "DELETE" });
    await section("starting-score", { method: "DELETE" });
  });

  afterAll(async () => {
    await server.shutdown();
  });

  const seatedTable = async (seats: [string, string]) => {
    const room = await server.createRoom("domino", {
      ...casualTable(seats, `seed-${seats[0]}`),
      matchId: `m-preset-${seats[0]}`,
      teamAssignment: "SEAT_ORDER",
    });
    const clients = [await joinAs(server, room.roomId, seats[0])];
    clients.push(await joinAs(server, room.roomId, seats[1]));
    const state = room.state as unknown as ServerState;
    await waitUntil(() => state.activeDeadline > 0);
    return { state, leave: () => Promise.all(clients.map((c) => c.leave().catch(() => 0))) };
  };

  it("la mesa siguiente reparte las fichas pedidas a cada asiento", async () => {
    const res = await section("deal", {
      method: "PATCH",
      body: JSON.stringify({ hands: [[[6, 6]], [[0, 0]]] }),
    });
    expect(res.status).toBe(200);

    const { state, leave } = await seatedTable(["d1", "d2"]);
    const has = (seat: number, left: number, right: number) =>
      state.players[seat]?.hand.tiles.some((tile) => tile.left === left && tile.right === right);

    expect(has(0, 6, 6)).toBe(true);
    expect(has(1, 0, 0)).toBe(true);
    await leave();
  });

  it("la mesa siguiente nace con el marcador pedido, acotado bajo la meta", async () => {
    const res = await section("starting-score", {
      method: "PATCH",
      body: JSON.stringify({ teamA: 50, teamB: 100_000 }),
    });
    expect(res.status).toBe(200);

    const { state, leave } = await seatedTable(["s1", "s2"]);

    // La meta de la mesa de la suite sale del catálogo; nadie nace en ella.
    expect(state.scoreboard.teamA).toBe(50);
    expect(state.scoreboard.teamB).toBeGreaterThan(50);
    expect(state.scoreboard.teamB).toBeLessThan(100_000);
    await leave();
  });

  it("un reparto imposible se rechaza: una ficha repetida no es un reparto raro", async () => {
    const res = await section("deal", {
      method: "PATCH",
      body: JSON.stringify({ hands: [[[6, 5]], [[5, 6]]] }),
    });

    expect(res.status).toBe(400);
  });
});
