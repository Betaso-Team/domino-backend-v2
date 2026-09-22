import { env } from "@/env";
import { SETTINGS_ROUTE } from "@/features/settings";
import { bootTestServer, casualTable, joinAs, waitUntil } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// LA CONFIGURACIÓN EDITADA CON EL SERVIDOR ANDANDO, desde el request que la cambia hasta la mesa que
// nace con el cambio. Vive acá arriba porque cruza dos features —la config y la partida— y es lo
// único que ningún test del motor puede mostrar: que un número movido por HTTP llega a una sala
// creada DESPUÉS, y que NO llega a una que ya estaba abierta. Portado de truco (`3cab0f8`).
//
// El DTO público del dominó no publica plazos, así que lo que se mira es el que el cliente de verdad
// ve: el `activeDeadline` de la ventana de reparto, que se estampa cuando los dos se sientan.
const PORT = 2610;
const admin = {
  "Content-Type": "application/json",
  "x-internal-api-key": env.adminPanelApiKey ?? "",
};

describe("La configuración editada en caliente (integración)", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    await fetch(`http://127.0.0.1:${PORT}${SETTINGS_ROUTE}/match`, {
      method: "DELETE",
      headers: admin,
    });
    await server.shutdown();
  });

  // Cuánto le queda a la ventana de reparto apenas se sentaron los dos. La suite corre con 800 ms.
  const dealingWindowOf = async (seats: [string, string]) => {
    const room = await server.createRoom("domino", {
      ...casualTable(seats, "seed-de-config"),
      matchId: `m-config-${seats[0]}`,
      teamAssignment: "SEAT_ORDER",
    });
    const clients = [await joinAs(server, room.roomId, seats[0])];
    clients.push(await joinAs(server, room.roomId, seats[1]));
    const state = room.state as { activeDeadline: number };
    await waitUntil(() => state.activeDeadline > 0);
    const remaining = state.activeDeadline - Date.now();
    await Promise.all(clients.map((client) => client.leave().catch(() => 0)));
    return { room, remaining };
  };

  it("llega a la mesa SIGUIENTE y no a la que ya está abierta", async () => {
    const before = await server.createRoom("domino", {
      ...casualTable(["a1", "a2"], "seed-de-config"),
      matchId: "m-config-abierta",
      teamAssignment: "SEAT_ORDER",
    });

    const res = await fetch(`http://127.0.0.1:${PORT}${SETTINGS_ROUTE}/match`, {
      method: "PATCH",
      headers: admin,
      body: JSON.stringify({ dealingTimeoutMs: 60_000 }),
    });
    expect(res.status).toBe(200);

    // La NUEVA nace con el número editado: sesenta segundos contra los 800 ms de la suite.
    const after = await dealingWindowOf(["b1", "b2"]);
    expect(after.remaining).toBeGreaterThan(30_000);

    // La que YA ESTABA ABIERTA —creada antes del parche, todavía sin nadie sentado— se queda con los
    // números con los que nació: los fotografió al crearse.
    const clients = [await joinAs(server, before.roomId, "a1")];
    clients.push(await joinAs(server, before.roomId, "a2"));
    const state = before.state as { activeDeadline: number };
    await waitUntil(() => state.activeDeadline > 0);
    expect(state.activeDeadline - Date.now()).toBeLessThanOrEqual(env.dealingTimeoutMs);
    await Promise.all(clients.map((client) => client.leave().catch(() => 0)));
  });
});
