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

interface LobbyStateDTO {
  readonly totalPlayers: number;
  readonly playersInLobby: number;
  readonly isUnderMaintenance: boolean;
  readonly maintenanceMessage: string;
  readonly gameModesCount: readonly {
    readonly gameModeName: string;
    readonly playerCount: number;
  }[];
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

  it("sincroniza mantenimiento y contadores por modo", async () => {
    const table = await server.createRoom("domino", casualTable(["lobby-a", "lobby-b"]));
    server.sdk.auth.token = mintToken(participantOf("lobby-a"));
    await server.connectTo(table);
    server.sdk.auth.token = mintToken(participantOf("lobby-b"));
    await server.connectTo(table);

    const room = await server.createRoom("lobby", {});
    server.sdk.auth.token = mintToken(participantOf("observer-a"));
    const first = await server.connectTo(room);
    server.sdk.auth.token = mintToken(participantOf("observer-b"));
    await server.connectTo(room);
    const state = first.state as LobbyStateDTO;

    await waitUntil(
      () =>
        state.totalPlayers === 2 &&
        state.playersInLobby === 2 &&
        state.gameModesCount.some(
          // El lobby cuenta por el `gameModeId` de la metadata, que desde la Tarea 10 es el uuid
          // del modo resuelto y ya no el nombre que el request traía.
          ({ gameModeName, playerCount }) => gameModeName === CASUAL_2P.uuid && playerCount === 2,
        ),
    );

    expect(state.isUnderMaintenance).toBe(false);
    expect(state.maintenanceMessage).toBe(
      "El juego de dominó está en mantenimiento. Vuelve pronto.",
    );
  });

  it("cambia mantenimiento sin deploy y bloquea solo mesas nuevas", async () => {
    const existing = await server.createRoom("domino", casualTable(["existing-a", "existing-b"]));
    const room = await server.createRoom("lobby", {});
    server.sdk.auth.token = mintToken(participantOf("operator-observer"));
    const client = await server.connectTo(room);
    const state = client.state as LobbyStateDTO;

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
    await waitUntil(
      () => state.isUnderMaintenance && state.maintenanceMessage === "Actualizando mesas",
    );

    expect(server.getRoomById(existing.roomId)).toBeDefined();
    await expect(
      server.createRoom("domino", casualTable(["blocked-a", "blocked-b"])),
    ).rejects.toThrow("Actualizando mesas");

    const disabled = await fetch("http://localhost:2592/internal/lobby/maintenance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.internalApiKey ?? "",
      },
      body: JSON.stringify({ isUnderMaintenance: false }),
    });
    expect(disabled.status).toBe(200);
    await expect(
      server.createRoom("domino", casualTable(["available-a", "available-b"])),
    ).resolves.toBeDefined();
  });
});
