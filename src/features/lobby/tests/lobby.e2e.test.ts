import { census, maintenanceSignal } from "@/di-container";
import { env } from "@/env";
import { bootTestServer, casualTable, mintToken, participantOf, waitUntil } from "@/tests/e2e";
import { CASUAL_2P } from "@/tests/game-mode-catalog";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL MODO SALE DEL CATÁLOGO SEMBRADO en `src/tests/game-mode-catalog.ts` y no de un literal: desde
// la Tarea 10 la sala lo resuelve contra el container, así que un `gameModeId` inventado acá haría
// que ninguna mesa de este archivo llegue a existir. El request tampoco trae ya dinero ni puntos.
//
// Se importa de `src/tests/` y no del arnés E2E del match porque la Regla 4 (`feature-boundary`)
// prohíbe que esta feature importe archivos internos de otra.

interface LobbyStats {
  readonly playersInMatch: number;
  readonly playersInLobby: number;
  readonly playersSearching: number;
  readonly byGameMode: readonly {
    readonly gameModeId: string;
    readonly playersInMatch: number;
    readonly playersSearching: number;
  }[];
}

interface Maintenance {
  readonly isUnderMaintenance: boolean;
  readonly message: string;
}

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootTestServer(2592);
});

afterAll(async () => {
  await server.shutdown();
});

describe("lobby", () => {
  it("exige la misma identidad autenticada que una mesa", async () => {
    const room = await server.createRoom("lobby", {});
    await server.sdk.auth.signOut();

    await expect(server.connectTo(room)).rejects.toThrow();
  });

  it("publica el censo del cluster y los jugadores del lobby", async () => {
    const table = await server.createRoom("domino", casualTable(["lobby-a", "lobby-b"]));
    server.sdk.auth.token = mintToken(participantOf("lobby-a"));
    await server.connectTo(table);
    server.sdk.auth.token = mintToken(participantOf("lobby-b"));
    await server.connectTo(table);
    await census.check();

    const room = await server.createRoom("lobby", {});
    server.sdk.auth.token = mintToken(participantOf("observer-a"));
    const first = await server.connectTo(room);
    const heard: LobbyStats[] = [];
    first.onMessage("LOBBY_STATS", (stats: LobbyStats) => heard.push(stats));
    server.sdk.auth.token = mintToken(participantOf("observer-b"));
    await server.connectTo(room);

    await waitUntil(() =>
      heard.some(
        (stats) =>
          stats.playersInMatch === 2 &&
          stats.playersInLobby === 2 &&
          stats.playersSearching === 0 &&
          stats.byGameMode.some(
            ({ gameModeId, playersInMatch }) =>
              gameModeId === CASUAL_2P.uuid && playersInMatch === 2,
          ),
      ),
    );
  });

  it("empuja el mantenimiento y cierra el matchmaking, no la partida viva", async () => {
    const existing = await server.createRoom("domino", casualTable(["existing-a", "existing-b"]));
    const room = await server.createRoom("lobby", {});
    server.sdk.auth.token = mintToken(participantOf("operator-observer"));
    const client = await server.connectTo(room);
    const heard: Maintenance[] = [];
    client.onMessage("MAINTENANCE", (maintenance: Maintenance) => heard.push(maintenance));

    const denied = await fetch("http://localhost:2592/internal/lobby/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isUnderMaintenance: true, message: "Actualizando mesas" }),
    });
    expect(denied.status).toBe(401);

    const malformed = await fetch("http://localhost:2592/internal/lobby/maintenance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.internalApiKey ?? "",
      },
      body: JSON.stringify({ isUnderMaintenance: "sí" }),
    });
    expect(malformed.status).toBe(400);

    const enabled = await fetch("http://localhost:2592/internal/lobby/maintenance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.internalApiKey ?? "",
      },
      body: JSON.stringify({ isUnderMaintenance: true, message: "Actualizando mesas" }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({
      isUnderMaintenance: true,
      maintenanceMessage: "Actualizando mesas",
    });
    await maintenanceSignal.check();
    await waitUntil(() => heard.some((value) => value.message === "Actualizando mesas"));

    expect(server.getRoomById(existing.roomId)).toBeDefined();
    const rejected = new Promise<{ reason: string }>((resolve) =>
      client.onMessage("MATCHMAKING_ERROR", resolve),
    );
    client.send("REQUEST_MATCH", { kind: "CASUAL", gameModeId: CASUAL_2P.uuid });
    await expect(rejected).resolves.toEqual({ reason: "MAINTENANCE" });

    const disabled = await fetch("http://localhost:2592/internal/lobby/maintenance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.internalApiKey ?? "",
      },
      body: JSON.stringify({ isUnderMaintenance: false }),
    });
    expect(disabled.status).toBe(200);
    await maintenanceSignal.check();
    await waitUntil(() => heard.some((value) => !value.isUnderMaintenance));
  });
});
