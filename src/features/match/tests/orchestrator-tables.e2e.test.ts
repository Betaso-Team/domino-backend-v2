import { env } from "@/env";
import { bootTestServer, casualTable, mintToken } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 2605;
const base = `http://127.0.0.1:${PORT}`;

const post = (path: string, body: unknown = {}, key = env.orchestratorApiKey ?? "") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-api-key": key },
    body: JSON.stringify(body),
  });

type Opened = {
  data: { roomId: string; seats: { userId: string; reservation: Record<string, unknown> }[] };
};

describe("la API del orquestador: abrir mesa y devolver el asiento", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });
  afterAll(async () => {
    await server.shutdown();
  });

  const sitEveryone = async ({ data }: Opened) => {
    for (const seat of data.seats) {
      server.sdk.auth.token = mintToken(seat.userId);
      const joined = await server.sdk.consumeSeatReservation(seat.reservation as never);
      expect(joined.roomId).toBe(data.roomId);
    }
  };

  it("abre una mesa con un rateId de Mongo y cada jugador entra con su reserva", async () => {
    const table = { ...casualTable(["o-a", "o-b"]), rateId: "69977c3dc3bf3e710572f941" };
    const res = await post("/internal/matches", table);
    expect(res.status).toBe(201);
    const opened = (await res.json()) as Opened;
    expect(opened.data.seats.map(({ userId }) => userId)).toEqual(["o-a", "o-b"]);
    await sitEveryone(opened);
  });

  it("le devuelve el asiento a quien sigue en una mesa llena, con el matchId del orquestador", async () => {
    const table = casualTable(["o-c", "o-d"]);
    const opened = (await (await post("/internal/matches", table)).json()) as Opened;
    // SENTADOS DE VERDAD: una sala llena y jugando es la que tiene que seguir aceptando la vuelta.
    await sitEveryone(opened);
    const res = await post("/internal/players/o-c/seat");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { matchId: string; reservation: { roomId: string } };
    };
    expect(body.data.matchId).toBe(table.matchId);
    expect(body.data.reservation.roomId).toBe(opened.data.roomId);
    // Y LA RESERVA SIRVE: se consume, con el token de quien vuelve. Sin consumirla la sala queda
    // esperando su plazo y el cierre del servidor se cuelga.
    server.sdk.auth.token = mintToken("o-c");
    const back = await server.sdk.consumeSeatReservation(body.data.reservation as never);
    expect(back.roomId).toBe(opened.data.roomId);
  });

  // UNA SALA BLOQUEADA NO ES UNA SALA AUSENTE: cada vuelta sin consumir es una reserva y cuenta
  // contra `maxClients` (asientos × 2). Con 2 sentados, 2 reservas la bloquean y `joinById` tira el
  // MISMO código que para una sala inexistente. Un 404 acá diría "no está en ninguna mesa" de quien
  // sí está sentado, y el orquestador le abriría una segunda.
  it("no contesta 404 cuando la sala existe pero está bloqueada", async () => {
    const opened = (await (
      await post("/internal/matches", casualTable(["o-i", "o-j"]))
    ).json()) as Opened;
    await sitEveryone(opened);
    type Back = { data: { reservation: Record<string, unknown> } };
    const pending: Back[] = [];
    let locked: Response | undefined;
    for (let i = 0; i < 4 && !locked; i++) {
      const res = await post("/internal/players/o-i/seat");
      if (res.status === 200) pending.push((await res.json()) as Back);
      else locked = res;
    }
    expect(locked?.status).toBe(500);
    // Se consumen las reservas que sí salieron: sin eso la sala espera su plazo (~15 s) y el cierre
    // del servidor se cuelga. Consumir una reserva ya emitida no depende del bloqueo.
    server.sdk.auth.token = mintToken("o-i");
    for (const { data } of pending) {
      await server.sdk.consumeSeatReservation(data.reservation as never);
    }
  });

  it("contesta 404 a quien no está en ninguna mesa", async () => {
    expect((await post("/internal/players/nadie/seat")).status).toBe(404);
  });

  it("contesta 422 a un modo que no existe", async () => {
    const res = await post("/internal/matches", casualTable(["o-e", "o-f"], "seed", "no-existe"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "UNKNOWN_GAME_MODE" });
  });

  it("no abre nada con la llave del panel: cada llave abre lo suyo", async () => {
    const res = await post("/internal/matches", casualTable(["o-g", "o-h"]), env.adminPanelApiKey);
    expect(res.status).toBe(401);
  });
});
