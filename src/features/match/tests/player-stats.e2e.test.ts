import { env } from "@/env";
import { bootTestServer, casualTable, mintToken, waitUntil } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL CABLEADO ENTERO: una partida real hasta el veredicto, el cierre que alimenta el store (decorador
// registrado) y `GET /me/stats` resolviendo ese mismo store. Lo que cuenta cada pieza se mide aparte.
const PORT = 2623;
const base = `http://127.0.0.1:${PORT}`;

type Opened = {
  data: { roomId: string; seats: { userId: string; reservation: Record<string, unknown> }[] };
};

const statsOf = async (userId: string) =>
  (await (
    await fetch(`${base}/me/stats`, { headers: { authorization: `Bearer ${mintToken(userId)}` } })
  ).json()) as { gamesPlayed: number; gamesWon: number; maxWinStreak: number };

describe("GET /me/stats después de una partida", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });
  afterAll(async () => {
    await server.shutdown();
  }, 30_000);

  it("el que se queda gana por abandono y el que se fue suma una jugada sin victoria", async () => {
    const res = await fetch(`${base}/internal/matches`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": env.orchestratorApiKey ?? "",
      },
      body: JSON.stringify(casualTable(["st-b", "st-a"])),
    });
    const opened = (await res.json()) as Opened;
    const rooms = [];
    for (const seat of opened.data.seats) {
      server.sdk.auth.token = mintToken(seat.userId);
      rooms.push(await server.sdk.consumeSeatReservation(seat.reservation as never));
    }
    const [quitter, stayer] = rooms;
    const state = () => stayer?.state as { currentRound?: { phase?: string } } | undefined;
    // Destapadas primero: con la ventana de reparto abierta, irse ANULA la partida y no cuenta.
    for (const room of rooms) room.send("REVEAL_TILES", {});
    await waitUntil(() => state()?.currentRound?.phase === "PLAYING");

    quitter?.send("ABANDON", {});

    // El cierre aplica las estadísticas justo después, sin esperar al pedido: se sondea.
    await waitUntil(async () => (await statsOf("st-b")).gamesPlayed === 1);
    expect(await statsOf("st-b")).toMatchObject({ gamesPlayed: 1, gamesWon: 0, gamesAbandoned: 1 });
    await waitUntil(async () => (await statsOf("st-a")).gamesPlayed === 1);
    expect(await statsOf("st-a")).toMatchObject({ gamesPlayed: 1, gamesWon: 1, maxWinStreak: 1 });
  });
});
