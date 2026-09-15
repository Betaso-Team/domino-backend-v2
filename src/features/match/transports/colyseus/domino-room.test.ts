import { ColyseusSDK } from "@colyseus/sdk";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testConfig } from "../../../../app.config.js";
import { rootContainer } from "../../../../di-container.js";
import { env } from "../../../../env.js";
import type { PlayerRef } from "../../../../shared/player-ref.js";
import type { HistoryReader } from "../../network/history.js";
import type { DominoRoomOptions, MatchParticipant } from "../match-contract.js";
import type { DominoRoom } from "./domino-room.js";

let server: ColyseusTestServer | undefined;

beforeAll(async () => {
  server = await boot(testConfig, 2584);
});

afterAll(async () => {
  await server?.cleanup();
  await server?.shutdown();
});

describe("DominoRoom", () => {
  it("deja la verificación del JWT en el TokenVerifier de instancia", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-auth"));
    const token = tokenOf("a");
    testServer.sdk.auth.token = token;

    await testServer.connectTo(room);

    expect(room.clients).toHaveLength(1);
    expect(room.clients[0]?.auth).toEqual({ platformId: "betaso", userUuid: "a", token });
  });

  it("no acumula reservas al reemplazar varias veces el mismo asiento", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-capacity"));
    const token = tokenOf("a");
    const b = await connect(testServer, room, "b");
    testServer.sdk.auth.token = token;
    let current = await testServer.connectTo(room);
    const oldReconnectionToken = current.reconnectionToken;

    for (let replacementNumber = 0; replacementNumber < 3; replacementNumber += 1) {
      current.reconnection.enabled = false;
      await current.leave(false);
      await waitUntil(
        () =>
          room.state.players.find((player) => player.playerId === "seat-1")?.connected === false,
      );
      expect(room.hasReachedMaxClients()).toBe(false);

      const replacement = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
      replacement.auth.token = token;
      current = await replacement.joinById(room.roomId);
      await current.waitForInitialState();
      await waitUntil(() => room.clients.length === 2);
      expect(room.state.players.find((player) => player.playerId === "seat-1")?.connected).toBe(
        true,
      );
    }

    await current.leave();
    await waitUntil(() => room.clients.length === 1);

    const stale = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
    await expect(stale.reconnect(oldReconnectionToken)).rejects.toThrow();
    expect(room.clients).toHaveLength(1);
    expect(room.clients[0]?.sessionId).toBe(b.sessionId);
    await b.leave();
  });

  it("no aborta al disponer una partida que ya tiene veredicto", async () => {
    const testServer = requiredServer();
    const matchId = "match-resolved-dispose";
    const room = await testServer.createRoom<DominoRoom>("domino", options(matchId));
    const a = await connect(testServer, room, "a");
    const b = await connect(testServer, room, "b");

    a.send("ABANDON", {});
    await waitUntil(() => room.state.phase === "PRESENTING_MATCH");
    await room.disconnect();

    expect(await historyTypes(matchId)).toContain("MATCH_RESOLVED");
    expect(await historyTypes(matchId)).not.toContain("MATCH_ABORTED");
    await Promise.all([a.leave().catch(() => 0), b.leave().catch(() => 0)]);
  });

  it("sí aborta al disponer una partida todavía sin veredicto", async () => {
    const testServer = requiredServer();
    const matchId = "match-unresolved-dispose";
    const room = await testServer.createRoom<DominoRoom>("domino", options(matchId));
    await connect(testServer, room, "a");

    await room.disconnect();

    expect(await historyTypes(matchId)).toContain("MATCH_ABORTED");
  });

  it("rechaza el token de reconexión de quien ya abandonó", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-out"));
    const a = await connect(testServer, room, "a");
    const b = await connect(testServer, room, "b");
    const oldReconnectionToken = a.reconnectionToken;

    a.send("ABANDON", {});
    await waitUntil(
      () =>
        room.state.players.find((player) => player.playerId === "seat-1")?.hasAbandoned === true,
    );
    a.reconnection.enabled = false;
    await a.leave(false);
    await waitUntil(() => room.clients.length === 1);

    const stale = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
    await expect(stale.reconnect(oldReconnectionToken)).rejects.toThrow();
    expect(room.clients).toHaveLength(1);
    expect(room.clients[0]?.sessionId).toBe(b.sessionId);
    await b.leave();
  });

  // LA PAREJA ES LA LLAVE DEL ASIENTO. El mismo `sub` firmado por dos plataformas son dos
  // personas, y la tercera —que no está en la mesa— no entra aunque comparta el UUID.
  it("distingue el mismo UUID de dos plataformas y rechaza una tercera", async () => {
    const testServer = requiredServer();
    const participants = [
      { platformId: "betaso", userUuid: "same", displayName: "Ada", currency: "VES" },
      { platformId: "partner", userUuid: "same", displayName: "Lin", currency: "USD" },
    ] as const;
    const room = await testServer.createRoom<DominoRoom>(
      "domino",
      options("match-platforms", participants),
    );
    const a = await connect(testServer, room, { platformId: "betaso", userUuid: "same" });
    const b = await connect(testServer, room, { platformId: "partner", userUuid: "same" });

    expect(room.clients.map((client) => client.userData)).toEqual(
      expect.arrayContaining([{ playerId: "seat-1" }, { playerId: "seat-2" }]),
    );

    const outsider = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
    outsider.auth.token = tokenOf({ platformId: "third", userUuid: "same" });
    await expect(outsider.joinById(room.roomId)).rejects.toThrow();
    await Promise.all([a.leave(), b.leave()]);
  });

  it("marca la configuración pública como no cacheable", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-cache"));

    const response = await fetch(`http://127.0.0.1:${portOf(testServer)}/config/${room.roomId}`);

    expect(response.headers.get("cache-control")).toBe("no-store");
    await room.disconnect();
  });
});

const defaultParticipants = [
  { platformId: "betaso", userUuid: "a", displayName: "A", currency: "VES" },
  { platformId: "betaso", userUuid: "b", displayName: "B", currency: "VES" },
] as const;

function options(
  matchId: string,
  participants: readonly MatchParticipant[] = defaultParticipants,
): DominoRoomOptions {
  return {
    mode: "CASUAL",
    matchId,
    gameModeId: "classic-2p",
    participants: [...participants],
    seed: "seed",
    pointsToWin: 100,
    teamAssignment: "SEAT_ORDER",
    rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
    entryFeeUcMinor: 125,
    prizeUcMinor: 250,
  };
}

// Un string es azúcar para "de la plataforma de siempre": los tests que no miden
// multiplataforma no tienen por qué escribir la pareja entera.
const tokenOf = (player: string | PlayerRef) => {
  const identity = typeof player === "string" ? { platformId: "betaso", userUuid: player } : player;
  return jwt.sign({ sub: identity.userUuid, platformId: identity.platformId }, env.jwtSecret, {
    algorithm: "HS256",
  });
};

function requiredServer(): ColyseusTestServer {
  if (!server) throw new Error("servidor de prueba no iniciado");
  return server;
}

function portOf(testServer: ColyseusTestServer): number {
  return (testServer.server as unknown as { readonly port: number }).port;
}

async function connect(
  testServer: ColyseusTestServer,
  room: DominoRoom,
  player: string | PlayerRef,
) {
  testServer.sdk.auth.token = tokenOf(player);
  return testServer.connectTo(room);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: se agotó el plazo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function historyTypes(matchId: string): Promise<string[]> {
  return (await rootContainer.resolve<HistoryReader>("HistoryReader").of(matchId)).map(
    (entry) => entry.type,
  );
}
