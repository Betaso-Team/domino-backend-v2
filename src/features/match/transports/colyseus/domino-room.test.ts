import { ColyseusSDK } from "@colyseus/sdk";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testConfig } from "../../../../app.config.js";
import { rootContainer } from "../../../../di-container.js";
import { env } from "../../../../env.js";
import type { MemoryHistory } from "../../network/transports/memory-history.js";
import type { DominoRoomOptions } from "../match-contract.js";
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
    const token = jwt.sign({ sub: "a" }, env.jwtSecret, {
      algorithm: "HS256",
    });
    testServer.sdk.auth.token = token;

    await testServer.connectTo(room);

    expect(room.clients).toHaveLength(1);
    expect(room.clients[0]?.auth).toEqual({ userId: "a", token });
  });

  it("no acumula reservas al reemplazar varias veces el mismo asiento", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-capacity"));
    const token = jwt.sign({ sub: "a" }, env.jwtSecret, {
      algorithm: "HS256",
    });
    const b = await connect(testServer, room, "b");
    testServer.sdk.auth.token = token;
    let current = await testServer.connectTo(room);
    const oldReconnectionToken = current.reconnectionToken;

    for (let replacementNumber = 0; replacementNumber < 3; replacementNumber += 1) {
      current.reconnection.enabled = false;
      await current.leave(false);
      await waitUntil(
        () => room.state.players.find((player) => player.playerId === "a")?.connected === false,
      );
      expect(room.hasReachedMaxClients()).toBe(false);

      const replacement = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
      replacement.auth.token = token;
      current = await replacement.joinById(room.roomId);
      await current.waitForInitialState();
      await waitUntil(() => room.clients.length === 2);
      expect(room.state.players.find((player) => player.playerId === "a")?.connected).toBe(true);
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

    expect(historyTypes(matchId)).toContain("MATCH_RESOLVED");
    expect(historyTypes(matchId)).not.toContain("MATCH_ABORTED");
    await Promise.all([a.leave().catch(() => 0), b.leave().catch(() => 0)]);
  });

  it("sí aborta al disponer una partida todavía sin veredicto", async () => {
    const testServer = requiredServer();
    const matchId = "match-unresolved-dispose";
    const room = await testServer.createRoom<DominoRoom>("domino", options(matchId));
    await connect(testServer, room, "a");

    await room.disconnect();

    expect(historyTypes(matchId)).toContain("MATCH_ABORTED");
  });

  it("rechaza el token de reconexión de quien ya abandonó", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-out"));
    const a = await connect(testServer, room, "a");
    const b = await connect(testServer, room, "b");
    const oldReconnectionToken = a.reconnectionToken;

    a.send("ABANDON", {});
    await waitUntil(
      () => room.state.players.find((player) => player.playerId === "a")?.hasAbandoned === true,
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

  it("marca la configuración pública como no cacheable", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-cache"));

    const response = await fetch(`http://127.0.0.1:${portOf(testServer)}/config/${room.roomId}`);

    expect(response.headers.get("cache-control")).toBe("no-store");
    await room.disconnect();
  });
});

function options(matchId: string): DominoRoomOptions {
  return {
    mode: "CASUAL",
    matchId,
    gameModeId: "classic-2p",
    seats: ["a", "b"],
    seed: "seed",
    pointsToWin: 100,
    teamAssignment: "SEAT_ORDER",
  };
}

function requiredServer(): ColyseusTestServer {
  if (!server) throw new Error("servidor de prueba no iniciado");
  return server;
}

function portOf(testServer: ColyseusTestServer): number {
  return (testServer.server as unknown as { readonly port: number }).port;
}

async function connect(testServer: ColyseusTestServer, room: DominoRoom, userId: string) {
  testServer.sdk.auth.token = jwt.sign({ sub: userId }, env.jwtSecret, {
    algorithm: "HS256",
  });
  return testServer.connectTo(room);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: se agotó el plazo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function historyTypes(matchId: string): string[] {
  return (rootContainer.resolve("HistoryPort") as MemoryHistory)
    .of(matchId)
    .map((entry) => entry.type);
}
