import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import {
  type SeatedMatch,
  bootServer,
  legalPlayFor,
  rejoinAs,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2586);
});

afterAll(async () => {
  await server.shutdown();
});

// Lee el estado TAL COMO LO RECIBIÓ el cliente, ya filtrado por su StateView.
const clientState = (match: SeatedMatch, userId: string): MatchState => {
  const client = match.clients[userId];
  if (!client) throw new Error(`sin cliente para ${userId}`);
  return client.state as MatchState;
};

const tilesSeenBy = (state: MatchState, owner: string) => [
  ...(state.players.find((player) => player.playerId === owner)?.hand.tiles ?? []),
];

// Espera a que a CADA uno le haya llegado su propia mano. Se espera sobre la vista que el
// test va a leer: afirmar sobre la de un cliente después de sincronizar la del otro deja
// una ventana en la que el cero que se mide es el patch que todavía no llegó.
const awaitDealtHands = async (match: SeatedMatch, viewers: readonly string[]) => {
  for (const viewer of viewers) {
    await waitUntil(() => tilesSeenBy(clientState(match, viewer), viewer).length === 7);
  }
};

describe("visibilidad — el rival no ve fichas ajenas", () => {
  it("cada jugador ve SU mano completa", async () => {
    const match = await seatPair(server, ["v1", "v2"]);
    await revealHands(match);
    await awaitDealtHands(match, ["v1", "v2"]);

    expect(tilesSeenBy(clientState(match, "v1"), "v1")).toHaveLength(7);
    expect(tilesSeenBy(clientState(match, "v2"), "v2")).toHaveLength(7);
  });

  // EL AGUJERO DEL V1. Allí `players` era un MapSchema completo con las fichas
  // reales, así que cualquier cliente leía la mano exacta de su rival en cada patch.
  it("NINGÚN jugador ve las fichas del rival", async () => {
    const match = await seatPair(server, ["w1", "w2"]);
    await revealHands(match);
    await awaitDealtHands(match, ["w1", "w2"]);

    expect(tilesSeenBy(clientState(match, "w1"), "w2")).toHaveLength(0);
    expect(tilesSeenBy(clientState(match, "w2"), "w1")).toHaveLength(0);
  });

  it("pero SÍ ve cuántas le quedan: tileCount es público", async () => {
    const match = await seatPair(server, ["x1", "x2"]);
    await revealHands(match);
    await awaitDealtHands(match, ["x1"]);

    const rival = clientState(match, "x1").players.find((player) => player.playerId === "x2");
    expect(rival?.hand.tileCount).toBe(7);
  });

  it("NADIE ve el pozo", async () => {
    const match = await seatPair(server, ["y1", "y2"]);
    await revealHands(match);
    await awaitDealtHands(match, ["y1", "y2"]);

    for (const viewer of ["y1", "y2"]) {
      expect([...(clientState(match, viewer).currentRound?.boneyard?.tiles ?? [])]).toHaveLength(0);
      // El conteo sí, que es lo que el front muestra.
      expect(clientState(match, viewer).currentRound?.boneyard?.count).toBe(14);
    }
  });

  it("una ficha jugada pasa a ser pública para los dos", async () => {
    const match = await seatPair(server, ["z1", "z2"]);
    await revealHands(match);
    await awaitDealtHands(match, ["z1", "z2"]);

    const turnHolder = match.serverState.currentRound?.currentTurn?.playerId;
    if (!turnHolder) throw new Error("sin turno en curso");
    // La jugada se elige sobre la vista DEL QUE JUEGA: si el cliente no pudiera derivarla
    // de lo que recibió, este test no tendría de dónde sacarla — que es la otra mitad de
    // lo que el smoke afirma.
    const play = legalPlayFor(clientState(match, turnHolder), turnHolder);
    if (!play) throw new Error("sin jugada legal");

    match.clients[turnHolder]?.send("PLAY_TILE", play);

    await waitUntil(() => match.serverState.currentRound?.board.tiles.length === 1);
    for (const viewer of ["z1", "z2"]) {
      await waitUntil(() => clientState(match, viewer).currentRound?.board.tiles.length === 1);
      const placed = clientState(match, viewer).currentRound?.board.tiles.at(0);
      expect([placed?.tile.left, placed?.tile.right]).toEqual([play.left, play.right]);
    }
  });

  // Es el bug de la vista del socket. Si la audiencia se resolviera sobre
  // room.clients, lo revelado mientras el jugador está fuera no llegaría nunca a su
  // vista y volvería CIEGO — sin su propia mano de la ronda nueva.
  it("lo revelado mientras estaba fuera le espera al volver", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    await revealHands(match);
    await awaitDealtHands(match, ["r1"]);

    await match.clients.r1?.leave(false);
    await waitUntil(
      () =>
        match.serverState.players.find((player) => player.playerId === "r1")?.connected === false,
    );

    const back = await rejoinAs(server, match.roomId, "r1");
    await waitUntil(() => back.state.players.length === 2);

    expect(tilesSeenBy(back.state, "r1")).toHaveLength(7);
    // Y sigue sin ver la del rival.
    expect(tilesSeenBy(back.state, "r2")).toHaveLength(0);
  });
});
