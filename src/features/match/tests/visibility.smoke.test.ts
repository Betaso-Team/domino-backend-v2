import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import { bootServer, rejoinAs, revealHands, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2586);
});

afterAll(async () => {
  await server.shutdown();
});

// Lee el estado TAL COMO LO RECIBIÓ el cliente, ya filtrado por su StateView.
const clientState = (match: Awaited<ReturnType<typeof seatPair>>, userId: string) =>
  match.clients[userId]?.state as MatchState;

const handTilesSeenBy = (
  match: Awaited<ReturnType<typeof seatPair>>,
  viewer: string,
  owner: string,
) => [...(clientState(match, viewer).players.find((p) => p.playerId === owner)?.hand.tiles ?? [])];

const tilesSeenBy = (state: MatchState, owner: string) => [
  ...(state.players.find((p) => p.playerId === owner)?.hand.tiles ?? []),
];

describe("visibilidad — el rival no ve fichas ajenas", () => {
  it("cada jugador ve SU mano completa", async () => {
    const match = await seatPair(server, ["v1", "v2"]);
    await revealHands(match);
    await waitUntil(() => handTilesSeenBy(match, "v1", "v1").length === 7);

    expect(handTilesSeenBy(match, "v1", "v1")).toHaveLength(7);
    expect(handTilesSeenBy(match, "v2", "v2")).toHaveLength(7);
  });

  // EL AGUJERO DEL V1. Allí `players` era un MapSchema completo con las fichas
  // reales, así que cualquier cliente leía la mano exacta de su rival en cada patch.
  it("NINGÚN jugador ve las fichas del rival", async () => {
    const match = await seatPair(server, ["w1", "w2"]);
    await revealHands(match);
    await waitUntil(() => handTilesSeenBy(match, "w1", "w1").length === 7);

    expect(handTilesSeenBy(match, "w1", "w2")).toHaveLength(0);
    expect(handTilesSeenBy(match, "w2", "w1")).toHaveLength(0);
  });

  it("pero SÍ ve cuántas le quedan: tileCount es público", async () => {
    const match = await seatPair(server, ["x1", "x2"]);
    await revealHands(match);
    await waitUntil(() => handTilesSeenBy(match, "x1", "x1").length === 7);

    const rival = clientState(match, "x1").players.find((p) => p.playerId === "x2");
    expect(rival?.hand.tileCount).toBe(7);
  });

  it("NADIE ve el pozo", async () => {
    const match = await seatPair(server, ["y1", "y2"]);
    await revealHands(match);
    await waitUntil(() => handTilesSeenBy(match, "y1", "y1").length === 7);

    for (const viewer of ["y1", "y2"]) {
      expect([...(clientState(match, viewer).currentRound?.boneyard?.tiles ?? [])]).toHaveLength(0);
      // El conteo sí, que es lo que el front muestra.
      expect(clientState(match, viewer).currentRound?.boneyard?.count).toBe(14);
    }
  });

  it("una ficha jugada pasa a ser pública para los dos", async () => {
    const match = await seatPair(server, ["z1", "z2"]);
    await revealHands(match);
    await waitUntil(() => handTilesSeenBy(match, "z1", "z1").length === 7);

    const turnHolder = match.serverState.currentRound?.currentTurn?.playerId as string;
    const own = handTilesSeenBy(match, turnHolder, turnHolder);
    const chosen = own[0];
    if (!chosen) throw new Error("mano vacía");

    match.clients[turnHolder]?.send("PLAY_TILE", {
      left: chosen.left,
      right: chosen.right,
      side: "RIGHT",
    });

    await waitUntil(() => match.serverState.currentRound?.board.tiles.length === 1);
    for (const viewer of ["z1", "z2"]) {
      await waitUntil(() => clientState(match, viewer).currentRound?.board.tiles.length === 1);
      const placed = clientState(match, viewer).currentRound?.board.tiles.at(0);
      expect([placed?.tile.left, placed?.tile.right]).toEqual([chosen.left, chosen.right]);
    }
  });

  // Es el bug de la vista del socket. Si la audiencia se resolviera sobre
  // room.clients, lo revelado mientras el jugador está fuera no llegaría nunca a su
  // vista y volvería CIEGO — sin su propia mano de la ronda nueva.
  it("lo revelado mientras estaba fuera le espera al volver", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    await revealHands(match);
    await waitUntil(() => handTilesSeenBy(match, "r1", "r1").length === 7);

    await match.clients.r1?.leave(false);
    await waitUntil(
      () => match.serverState.players.find((p) => p.playerId === "r1")?.connected === false,
    );

    const back = await rejoinAs(server, match.roomId, "r1");
    await waitUntil(() => (back.state as MatchState).players.length === 2);

    expect(tilesSeenBy(back.state as MatchState, "r1")).toHaveLength(7);
    // Y sigue sin ver la del rival.
    expect(tilesSeenBy(back.state as MatchState, "r2")).toHaveLength(0);
  });
});
