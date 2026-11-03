import { rootContainer } from "@/di-container";
import { env } from "@/env";
import { matchMaker } from "@colyseus/core";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GlobalConfigSource, globalConfigWith } from "../core/config";
import { MatchRegistry } from "../transports/match-registry";
import {
  type SeatedMatch,
  bootServer,
  clientOf,
  linesOf,
  mintToken,
  playOneTurn,
  playerIdOf,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

const PORT = 2641;

// LOS DOS SE CAEN A LA VEZ, que en el dominó v1 fue un incidente de producción (Betaso-Domino-Backend
// PR #8, `b1100d4`): la sala quedaba sin sockets, se daba por muerta, se borraban las sesiones y la
// partida cerraba por TIMEOUT sin nadie en la mesa. Acá no debería pasar por diseño —el asiento lo
// sostiene el latido de la sala en el `MatchRegistry`, y Colyseus no dispone una sala con
// reconexiones pendientes—, y esta suite es lo que lo sostiene.
//
// LA VENTANA SE AGRANDA Y EL TURNO MÁS TODAVÍA. Con los 500 ms de la suite no hay tiempo de mirar la
// mesa vacía antes de que venza; y el reloj del turno NO se pausa con la caída, así que con los
// 600 + 300 ms de la suite el que tenía el turno lo perdería por tiempo y el test mediría esa carrera
// y no la caída. El turno queda por encima de la ventana: lo que se mide es que la mesa espere.
const WINDOW_SECONDS = 3;
let originalSource: GlobalConfigSource;
let server: ColyseusTestServer;

beforeAll(async () => {
  originalSource = rootContainer.resolve<GlobalConfigSource>("GlobalConfigSource");
  const base = originalSource();
  rootContainer.register<GlobalConfigSource>("GlobalConfigSource", {
    useValue: () =>
      globalConfigWith({
        ...base,
        reconnectionWindowSeconds: WINDOW_SECONDS,
        turnTimeoutMs: (WINDOW_SECONDS + 5) * 1_000,
      }),
  });
  server = await bootServer(PORT);
});

afterAll(async () => {
  await server.shutdown();
  rootContainer.register("GlobalConfigSource", { useValue: originalSource });
});

const playerOf = (match: SeatedMatch, userId: string) =>
  match.serverState.players.find((player) => player.playerId === playerIdOf(match, userId));

const roomAlive = async (match: SeatedMatch) =>
  (await matchMaker.query({ roomId: match.roomId })).length === 1;

const seatBack = (userId: string) =>
  fetch(`http://127.0.0.1:${PORT}/internal/players/${userId}/seat`, {
    method: "POST",
    headers: { "x-internal-api-key": env.orchestratorApiKey ?? "" },
  });

// UNA PARTIDA CON LA RONDA EN JUEGO y una ficha en la mesa: así "la partida sigue" se mide jugando,
// no mirando la fase.
async function matchInPlay(users: readonly [string, string]): Promise<SeatedMatch> {
  const match = await seatPair(server, users);
  await waitUntil(() => match.serverState.phase === "PLAYING");
  await revealHands(match);
  await playOneTurn(match);
  return match;
}

// LA MESA VACÍA, mirada mientras los dos siguen afuera: la sala viva, nadie retirado y los dos
// asientos todavía en el índice que el orquestador consulta para mandar `ACTIVE_MATCH`.
async function expectTableHeld(match: SeatedMatch, users: readonly string[]): Promise<void> {
  expect(await roomAlive(match)).toBe(true);
  expect(match.serverState.phase).toBe("PLAYING");
  expect(match.serverState.currentRound?.phase).toBe("PLAYING");
  const registry = rootContainer.resolve(MatchRegistry);
  for (const userId of users) {
    expect(playerOf(match, userId)?.hasAbandoned).toBe(false);
    expect(await registry.matchOf(userId)).toBe(match.roomId);
  }
}

async function expectMatchGoesOn(match: SeatedMatch, users: readonly string[]): Promise<void> {
  expect(await playOneTurn(match)).toBe(true);
  expect(match.serverState.phase).toBe("PLAYING");
  for (const userId of users) expect(playerOf(match, userId)?.hasAbandoned).toBe(false);
  const lines = await linesOf(match.config.matchId);
  expect(lines).not.toContain("SYSTEM ABANDON");
  expect(lines).not.toContain("SYSTEM MATCH_ABORTED");
  expect(lines).not.toContain("SYSTEM MATCH_RESOLVED");
  expect(lines).not.toContain("SYSTEM PLAYER_DISCONNECTED");
}

describe("los dos jugadores se caen a la vez", () => {
  it("la mesa espera a los dos y el SDK los devuelve solo", async () => {
    const users = ["sd1", "sd2"] as const;
    const match = await matchInPlay(users);
    const clients = users.map((userId) => clientOf(match, userId));
    const reconnected = new Set<string>();
    for (const [index, client] of clients.entries()) {
      // `minUptime = 0`: una mesa de test es más joven que los 5 s con los que el SDK se niega a
      // reintentar. El primer reintento a ~1 s y no a los 200 ms del default: deja ver la mesa VACÍA
      // —los dos afuera a la vez— antes de que alguno vuelva.
      client.reconnection.minUptime = 0;
      client.reconnection.delay = 500;
      client.onReconnect(() => reconnected.add(users[index] as string));
    }

    // CIERRE NO CONSENTIDO DE LOS DOS EN EL MISMO TURNO, y sin `await`: una caída con reintento
    // armado no dispara `onLeave`, así que esperar `leave()` cuelga.
    for (const client of clients) void client.leave(false);

    await waitUntil(() => users.every((userId) => playerOf(match, userId)?.connected === false));
    expect(reconnected.size).toBe(0);
    await expectTableHeld(match, users);

    await waitUntil(() => reconnected.size === 2, WINDOW_SECONDS * 1_000);
    await waitUntil(() => users.every((userId) => playerOf(match, userId)?.connected === true));
    await expectMatchGoesOn(match, users);
  });

  // EL CAMINO DESPUÉS DE QUE EL SDK SE RINDE: el orquestador pide el asiento de vuelta
  // (`POST /internal/players/:userId/seat`, el que alimenta `ACTIVE_MATCH`) y el jugador entra con
  // una reserva nueva, con la sala sin un solo socket.
  it("con la mesa vacía, los dos vuelven con una reserva nueva del orquestador", async () => {
    const users = ["sr1", "sr2"] as const;
    const match = await matchInPlay(users);
    const clients = users.map((userId) => clientOf(match, userId));
    for (const client of clients) client.reconnection.enabled = false;

    await Promise.all(clients.map((client) => client.leave(false)));
    await waitUntil(() => users.every((userId) => playerOf(match, userId)?.connected === false));
    await expectTableHeld(match, users);

    const reservations = [];
    for (const userId of users) {
      const res = await seatBack(userId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { matchId: string; reservation: { roomId: string } };
      };
      expect(body.data.matchId).toBe(match.config.matchId);
      expect(body.data.reservation.roomId).toBe(match.roomId);
      reservations.push(body.data.reservation);
    }

    for (const [index, userId] of users.entries()) {
      server.sdk.auth.token = mintToken(userId);
      const back = await server.sdk.consumeSeatReservation<object>(reservations[index] as never);
      expect(back.roomId).toBe(match.roomId);
      // LA MESA HABLA CON EL CLIENTE NUEVO: el viejo se cerró y `act` manda por éste.
      match.clients[playerIdOf(match, userId)] = back;
    }
    await waitUntil(() => users.every((userId) => playerOf(match, userId)?.connected === true));
    await expectMatchGoesOn(match, users);
  });
});
