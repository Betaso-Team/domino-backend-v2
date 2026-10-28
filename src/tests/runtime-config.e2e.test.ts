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
// Se mira por las dos caras que ve el cliente: el `activeDeadline` de la ventana de reparto, que se
// estampa cuando los dos se sientan, y los `timeouts` de `GET /config/:roomId`, que es de donde el
// front saca el largo entero del plazo para dibujar el anillo.
const PORT = 2610;
const admin = {
  "Content-Type": "application/json",
  "x-internal-api-key": env.adminApiKey ?? "",
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

  const timeoutsOf = async (roomId: string) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/config/${roomId}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { timeouts: { turnMs: number; dealingMs: number } }).timeouts;
  };

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
    // Antes de que se vayan: con la mesa vacía la sala se dispone y sale del registro.
    const timeouts = await timeoutsOf(room.roomId);
    await Promise.all(clients.map((client) => client.leave().catch(() => 0)));
    return { room, remaining, timeouts };
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
      body: JSON.stringify({ dealingTimeoutMs: 60_000, turnTimeoutMs: 45_000 }),
    });
    expect(res.status).toBe(200);

    // La NUEVA nace con el número editado: sesenta segundos contra los 800 ms de la suite.
    const after = await dealingWindowOf(["b1", "b2"]);
    expect(after.remaining).toBeGreaterThan(30_000);
    // Y lo PUBLICA: el front dibuja el anillo con el plazo de la mesa y no con una constante suya.
    expect(after.timeouts).toMatchObject({
      turnMs: 45_000,
      dealingMs: 60_000,
    });
    // La abierta sigue publicando los suyos, que no son los del parche.
    expect(await timeoutsOf(before.roomId)).toMatchObject({
      turnMs: env.turnTimeoutMs,
      dealingMs: env.dealingTimeoutMs,
    });

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
