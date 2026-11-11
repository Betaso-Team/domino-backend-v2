import { rootContainer } from "@/di-container";
import { env } from "@/env";
import { findBadAmounts } from "@/shared/tests/find-bad-amounts";
import { bootTestServer, casualTable, mintToken, waitUntil } from "@/tests/e2e";
import { CASUAL_4P } from "@/tests/table-modes";
import { matchMaker } from "@colyseus/core";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayConfigOf } from "../transports/match-contract";
import { MatchRegistry } from "../transports/match-registry";

const PORT = 2605;
const base = `http://127.0.0.1:${PORT}`;

const post = (path: string, body: unknown = {}, key = env.orchestratorApiKey ?? "") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-api-key": key },
    body: JSON.stringify(body),
  });

const get = (path: string, key = env.orchestratorApiKey ?? "") =>
  fetch(`${base}${path}`, { headers: { "x-internal-api-key": key } });

type Opened = {
  data: { roomId: string; seats: { userId: string; reservation: Record<string, unknown> }[] };
};

describe("la API del orquestador: abrir mesa y devolver el asiento", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });
  // UN PLAZO MAYOR QUE LA RESERVA DE ASIENTO DE COLYSEUS (15 s). Los casos que esperan el 404 del
  // asiento de vuelta lo piden en un bucle, y cada 200 en el camino RESERVA un asiento que nadie
  // consume: como la mesa suelta a sus jugadores apenas tiene veredicto, con la sala todavía viva,
  // esas reservas la retienen hasta vencer y el cierre del servidor espera con ellas.
  afterAll(async () => {
    await server.shutdown();
  }, 30_000);

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

  // UNA MESA TERMINADA NO RETIENE A NADIE, aunque la sala siga viva. Antes el registro anotaba los
  // asientos del config hasta que la sala se disponía, así que el orquestador le devolvía al
  // jugador una mesa donde `onJoin` lo rechaza (`PlayerAlreadyOutError`) y no le abría otra.
  it("suelta a los dos apenas la partida tiene veredicto, con la sala todavía abierta", async () => {
    const opened = (await (
      await post("/internal/matches", casualTable(["o-r1", "o-r2"]))
    ).json()) as Opened;
    const rooms = [];
    for (const seat of opened.data.seats) {
      server.sdk.auth.token = mintToken(seat.userId);
      rooms.push(await server.sdk.consumeSeatReservation(seat.reservation as never));
    }
    const [quitter, stayer] = rooms;
    const state = () =>
      stayer?.state as { phase?: string; currentRound?: { phase?: string } } | undefined;
    await waitUntil(() => state()?.phase !== undefined && state()?.phase !== "NOT_STARTED");
    // Destapadas primero: con la ventana de reparto abierta, irse ANULA la partida (el caso de abajo).
    for (const room of rooms) room.send("REVEAL_TILES", {});
    await waitUntil(() => state()?.currentRound?.phase === "PLAYING");

    quitter?.send("ABANDON", {});

    await waitUntil(async () => (await post("/internal/players/o-r2/seat")).status === 404);
    expect((await post("/internal/players/o-r1/seat")).status).toBe(404);
    expect(stayer?.connection.isOpen).toBe(true);
  });

  // Y TAMBIÉN LA ANULADA EN EL REPARTO, que no tiene veredicto: no hay revancha posible ni partida
  // que volver a jugar, así que retener al que se quedó lo mandaría de vuelta a una mesa muerta —y
  // el orquestador no podría abrirle otra hasta que la sala se disponga—.
  it("suelta a los dos cuando la partida se anula en el reparto", async () => {
    const opened = (await (
      await post("/internal/matches", casualTable(["o-z1", "o-z2"]))
    ).json()) as Opened;
    const rooms = [];
    for (const seat of opened.data.seats) {
      server.sdk.auth.token = mintToken(seat.userId);
      rooms.push(await server.sdk.consumeSeatReservation(seat.reservation as never));
    }
    const [quitter, stayer] = rooms;
    const state = () => stayer?.state as { phase?: string } | undefined;
    await waitUntil(() => state()?.phase !== undefined && state()?.phase !== "NOT_STARTED");

    quitter?.send("ABANDON", {});

    await waitUntil(async () => (await post("/internal/players/o-z2/seat")).status === 404);
    expect((await post("/internal/players/o-z1/seat")).status).toBe(404);
    expect(state()?.phase).not.toBe("PLAYING");
  });

  // LAS VUELTAS SIN CONSUMIR NO LE CIERRAN LA MESA A SU DUEÑO. Cada vuelta es una reserva, y con el
  // viejo `maxClients = asientos × 2` dos de ellas sobre una mesa llena la bloqueaban: `joinById`
  // tiraba el mismo código que para una sala inexistente y el que de verdad estaba sentado se quedaba
  // afuera de su propia partida (portado de truco `b90840b`). Sin tope, la sala no se bloquea nunca.
  it("sigue devolviendo el asiento aunque haya vueltas sin consumir", async () => {
    const opened = (await (
      await post("/internal/matches", casualTable(["o-i", "o-j"]))
    ).json()) as Opened;
    await sitEveryone(opened);
    type Back = { data: { reservation: Record<string, unknown> } };
    const pending: Back[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await post("/internal/players/o-i/seat");
      expect(res.status).toBe(200);
      pending.push((await res.json()) as Back);
    }
    // Se consumen: sin eso la sala espera el plazo de cada reserva (~15 s) y el cierre del servidor
    // se cuelga. Cada una desplaza a la anterior, y la mesa sigue con dos conexiones.
    server.sdk.auth.token = mintToken("o-i");
    for (const { data } of pending) {
      await server.sdk.consumeSeatReservation(data.reservation as never);
    }
    await waitUntil(() => server.getRoomById(opened.data.roomId).clients.length === 2);
  });

  // LA MESA DE UN JUGADOR SIN RESERVAR NADA: lo que el orquestador pregunta para no abrirle otra. Sin
  // reservas en el camino, así que esperar el 404 con un bucle no retiene la sala.
  it("dice en qué mesa está cada uno sin reservar, y deja de decirlo al soltarlo", async () => {
    const table = casualTable(["o-m1", "o-m2"]);
    const opened = (await (await post("/internal/matches", table)).json()) as Opened;
    const room = server.getRoomById(opened.data.roomId);
    const rooms = [];
    for (const seat of opened.data.seats) {
      server.sdk.auth.token = mintToken(seat.userId);
      rooms.push(await server.sdk.consumeSeatReservation(seat.reservation as never));
    }

    const res = await get("/internal/players/o-m1/match");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "success",
      data: { matchId: table.matchId, roomId: opened.data.roomId, mode: "CASUAL" },
    });
    // NINGUNA RESERVA NUEVA: la sala sigue con sus dos clientes y nada más.
    expect(room.clients.length).toBe(2);

    const [quitter] = rooms;
    quitter?.send("ABANDON", {});
    await waitUntil(async () => (await get("/internal/players/o-m1/match")).status === 404);
    const gone = await get("/internal/players/o-m1/match");
    expect(await gone.json()).toEqual({ code: "NO_LIVE_MATCH" });
    expect((await get("/internal/players/nadie/match")).status).toBe(404);
  });

  // EL PRECIO EN LA MONEDA DE CADA UNO, de punta a punta: entra por el pedido del orquestador y sale por
  // las dos puertas de la config pública —`GET /config/:roomId` y el mensaje `config` al sentarse—, por
  // el id opaco de cada asiento.
  it("publica en la config el precio de cada asiento que lo trajo", async () => {
    const price = {
      currency: "VES",
      rate: "200",
      entry: "25000.00",
      prize: "50000.00",
      levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
    };
    const table = casualTable([
      { userId: "o-p1", displayName: "P1", currency: "VES", price },
      { userId: "o-p2", displayName: "P2", currency: "USD" },
    ]);
    const res = await post("/internal/matches", table);
    expect(res.status).toBe(201);
    const opened = (await res.json()) as Opened;

    const config = (await (await fetch(`${base}/config/${opened.data.roomId}`)).json()) as {
      seats: string[];
      seatPrices?: unknown;
    };
    expect(config.seats).toEqual(["seat-1", "seat-2"]);
    // EN LA CONVENCIÓN DE MONTOS v2: una entidad en su moneda, con la tasa de la mesa con la que billing
    // cotizó, y sin `uc`.
    const published = {
      "seat-1": {
        currency: "VES",
        rateId: table.rateId,
        rate: "200",
        entry: "25000.00",
        prize: "50000.00",
        levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
      },
    };
    expect(config.seatPrices).toEqual(published);

    const received: { seatPrices?: unknown }[] = [];
    for (const seat of opened.data.seats) {
      server.sdk.auth.token = mintToken(seat.userId);
      const room = await server.sdk.consumeSeatReservation(seat.reservation as never);
      room.onMessage("config", (message: { seatPrices?: unknown }) => {
        received.push(message);
      });
    }
    await waitUntil(() => received.length === 2);
    for (const message of received) {
      expect(message.seatPrices).toEqual(published);
      expect(findBadAmounts(message, ["entryFee", "prize", "entry"])).toEqual([]);
    }
  });

  it("rechaza con 400 un precio malformado, sin abrir nada", async () => {
    const table = casualTable([
      { userId: "o-q1", displayName: "Q1", currency: "VES" },
      { userId: "o-q2", displayName: "Q2", currency: "VES" },
    ]);
    const participants = table.participants.map((participant) => ({
      ...participant,
      price: { currency: "VES", rate: "200", entry: 200, prize: "300.00" },
    }));
    const res = await post("/internal/matches", { ...table, participants });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "MALFORMED" });
  });

  // T-04 (truco `53d1030`): LA SALA DE UN PROCESO QUE MURIÓ DE GOLPE. Sigue anunciada en el registro de
  // salas y sus jugadores siguen en `player_match`, porque `onDispose` no corrió. `joinById` no dice «no
  // existe»: le pide el asiento al dueño, no contesta, Colyseus le hace el chequeo de salud, lo excluye,
  // borra sus salas y tira `SeatReservationError`. Antes era un 500 —`TABLE_UNAVAILABLE` en el
  // orquestador— y el jugador quedaba trabado hasta que su entrada vencía. Tarda los dos plazos de IPC
  // de Colyseus (2 s cada uno): el del asiento y el del chequeo de salud.
  it("la sala de un proceso muerto no retiene a nadie: 404 y su entrada borrada", async () => {
    const roomId = "sala-de-un-muerto";
    const registry = rootContainer.resolve(MatchRegistry);
    const seat = (userId: string, index: number) => ({
      userId,
      displayName: userId,
      currency: "VES",
      playerId: `seat-${index + 1}`,
    });
    await registry.register(
      roomId,
      replayConfigOf({
        matchId: "m-muerta",
        gameModeId: "modo",
        seats: [seat("o-k1", 0), seat("o-k2", 1)],
        seed: "seed",
        pointsToWin: 100,
        teamAssignment: "SEAT_ORDER",
        isDealWindowEnabled: true,
        rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
        entryFee: 10,
        prize: 20,
      }),
      { turnMs: 1, extraTimeMs: 1, dealingMs: 1, betResponseMs: 1 },
    );
    await matchMaker.driver.persist(
      {
        name: "domino",
        roomId,
        processId: "proceso-muerto",
        clients: 0,
        maxClients: Number.POSITIVE_INFINITY,
        locked: false,
        private: false,
      },
      true,
    );

    const seatBack = await post("/internal/players/o-k1/seat");
    expect(seatBack.status).toBe(404);
    expect(await seatBack.json()).toEqual({ code: "NO_LIVE_MATCH" });
    expect(await registry.matchOf("o-k1")).toBeUndefined();

    // EL OTRO JUGADOR, por la pregunta sin reserva: la sala ya no figura —la sacó el chequeo de salud
    // de arriba— así que su entrada también se borra.
    expect(await registry.matchOf("o-k2")).toBe(roomId);
    const match = await get("/internal/players/o-k2/match");
    expect(match.status).toBe(404);
    expect(await match.json()).toEqual({ code: "NO_LIVE_MATCH" });
    expect(await registry.matchOf("o-k2")).toBeUndefined();
    await registry.remove(roomId);
  });

  it("contesta 404 a quien no está en ninguna mesa", async () => {
    expect((await post("/internal/players/nadie/seat")).status).toBe(404);
  });

  it("contesta 422 a una mesa cuyos asientos no son los del modo", async () => {
    const res = await post("/internal/matches", casualTable(["o-e", "o-f"], "seed", CASUAL_4P));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "SEAT_COUNT_MISMATCH" });
  });

  it("contesta 400 a una mesa casual sin su modo en línea", async () => {
    const { gameMode: _, ...withoutMode } = casualTable(["o-e2", "o-f2"]);
    expect((await post("/internal/matches", withoutMode)).status).toBe(400);
  });

  it("no abre nada con la llave del panel: cada llave abre lo suyo", async () => {
    const res = await post("/internal/matches", casualTable(["o-g", "o-h"]), env.adminApiKey);
    expect(res.status).toBe(401);
  });
});
