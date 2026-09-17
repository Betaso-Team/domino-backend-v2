import { testConfig } from "@/app.config.js";
import { gameModes, rootContainer } from "@/di-container.js";
import { env } from "@/env.js";
import type { PlayerRef } from "@/shared/player-ref.js";
import { CASUAL_2P } from "@/tests/game-mode-catalog.js";
import { ColyseusSDK } from "@colyseus/sdk";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HistoryReader } from "../../network/history.js";
import type { CreateMatchRequest, MatchParticipant } from "../match-contract.js";
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

  // LA SALA NO NACE SI EL DINERO NO CIERRA, y esto es lo único que lo pinea EN EL CABLEADO.
  // `configOf` tiene sus propios tests, pero en aislamiento: que `onCreate` lo LLAME —y que no
  // atrape lo que lanza— es una arista aparte, y es justo la que un refactor rompe en silencio.
  // Es el patrón de `fdd99b6`: la regla estaba escrita, el test miraba el borde equivocado y
  // daba verde sobre una violación viva. Una sala creada con una tasa inválida ya cobró.
  it("no crea la sala si las opciones no pasan el contrato", async () => {
    const testServer = requiredServer();

    // `/rateId/` y no un `toThrow()` pelado: el rechazo tiene que venir del CONTRATO y nombrar
    // el campo. Sin el patrón, cualquier otra falla de arranque —un container a medio cablear,
    // un puerto tomado— dejaría este test verde sin que `configOf` se llame una sola vez.
    await expect(
      testServer.createRoom<DominoRoom>("domino", { ...options("match-bad"), rateId: "no-uuid" }),
    ).rejects.toThrow(/rateId/);
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

  // EL CATÁLOGO ES LA AUTORIDAD, Y LA SALA LO CONSULTA. Estos cinco `it` son el cableado: los
  // rechazos en sí los mide `match-contract.test.ts` en aislamiento, pero que `onCreate` LLAME al
  // catálogo —y que no atrape lo que lanza— es una arista aparte, y es justo la que un refactor
  // rompe en silencio. Una sala creada con un modo inventado ya cobró la inscripción.
  it("no crea la sala con un modo que no está en el catálogo", async () => {
    const testServer = requiredServer();

    await expect(
      testServer.createRoom<DominoRoom>("domino", {
        ...options("match-unknown-mode"),
        gameModeId: "00000000-0000-4000-8000-00000000dead",
      }),
    ).rejects.toThrow(/UNKNOWN_GAME_MODE/);
  });

  // UN MODO DADO DE BAJA NO EXISTE DESDE AFUERA, y esta es la diferencia entre `activeByUuid` y
  // `byUuid`. El panel da de baja un modo justamente para que deje de sentar mesas; con `byUuid`
  // el retiro sería decorativo y el modo seguiría cobrando.
  it("no crea la sala con un modo dado de baja", async () => {
    const testServer = requiredServer();
    const retirado = await gameModes.create({
      name: "retirado-2p",
      playersQuantity: 2,
      pointsToWin: 50,
      entryFee: 10,
      prize: 20,
    });
    await gameModes.update(retirado.uuid, { isActive: false });

    await expect(
      testServer.createRoom<DominoRoom>("domino", {
        ...options("match-inactive-mode"),
        gameModeId: retirado.uuid,
      }),
    ).rejects.toThrow(/UNKNOWN_GAME_MODE/);
  });

  // EL 4P SE RECHAZA ANTES DE GÉNESIS. No hay regla escrita de cómo se parte el premio entre
  // compañeros, así que `settlementOf` lanza DESPUÉS del veredicto: sin premio y sin reembolso,
  // plata trabada. La sala no llega a existir, que es lo que mantiene esa deuda inerte.
  it("no crea la sala con un modo de cuatro jugadores", async () => {
    const testServer = requiredServer();
    const cuatro = await gameModes.create({
      name: "clasica-4p",
      playersQuantity: 4,
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });

    await expect(
      testServer.createRoom<DominoRoom>("domino", {
        ...options("match-4p", [
          ...defaultParticipants,
          { platformId: "betaso", userUuid: "c", displayName: "C", currency: "VES" },
          { platformId: "betaso", userUuid: "d", displayName: "D", currency: "VES" },
        ]),
        gameModeId: cuatro.uuid,
      }),
    ).rejects.toThrow(/UNSUPPORTED_GAME_MODE/);
  });

  // LA CANTIDAD LA DECIDE EL MODO. Cuatro participantes sobre un modo de dos serían cuatro
  // asientos en una mesa cuyo premio se configuró para dos.
  it("no crea la sala si los participantes no son los del modo", async () => {
    const testServer = requiredServer();

    await expect(
      testServer.createRoom<DominoRoom>(
        "domino",
        options("match-seat-mismatch", [
          ...defaultParticipants,
          { platformId: "betaso", userUuid: "c", displayName: "C", currency: "VES" },
          { platformId: "betaso", userUuid: "d", displayName: "D", currency: "VES" },
        ]),
      ),
    ).rejects.toThrow(/SEAT_COUNT_MISMATCH/);
  });

  // EL SNAPSHOT SE CONGELA EN `onCreate`, y esta es la mitad reproducible de la tarea. El catálogo
  // se consulta UNA vez; editar el modo después no puede cambiarle los puntos ni el premio a una
  // mesa cuya inscripción YA se cobró. Sin esto —con una sala que releyera el catálogo— un cambio
  // de precio del panel reescribiría en caliente la economía de todas las partidas en curso.
  it("congela el modo: editarlo después no cambia ni el estado ni la configuración pública", async () => {
    const testServer = requiredServer();
    const editable = await gameModes.create({
      name: "editable-2p",
      playersQuantity: 2,
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });
    const room = await testServer.createRoom<DominoRoom>("domino", {
      ...options("match-frozen-mode"),
      gameModeId: editable.uuid,
    });

    expect(room.state.pointsToWin).toBe(100);
    expect(await configOfRoom(testServer, room.roomId)).toMatchObject({
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });

    await gameModes.update(editable.uuid, { pointsToWin: 7, entryFee: 1, prize: 2 });

    // Los números van como LITERAL y no releídos del modo: leerlos del catálogo mediría que dos
    // lecturas del mismo dato coinciden, y quedaría verde si la sala empezara a releerlo.
    expect(room.state.pointsToWin).toBe(100);
    expect(await configOfRoom(testServer, room.roomId)).toMatchObject({
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });

    // Y LA EDICIÓN SÍ OCURRIÓ, que es lo que impide que las tres aserciones de arriba pasen por la
    // razón equivocada: una mesa NUEVA nace con los valores nuevos. Sin esta vuelta, un `update`
    // que no escribiera nada dejaría el test verde midiendo el catálogo que nunca cambió.
    const nueva = await testServer.createRoom<DominoRoom>("domino", {
      ...options("match-after-edit"),
      gameModeId: editable.uuid,
    });
    expect(nueva.state.pointsToWin).toBe(7);
    expect(await configOfRoom(testServer, nueva.roomId)).toMatchObject({
      pointsToWin: 7,
      entryFee: 1,
      prize: 2,
    });

    await Promise.all([room.disconnect(), nueva.disconnect()]);
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

// El request YA NO TRAE DINERO NI PUNTOS: los pone el modo que `src/tests/game-mode-catalog.ts`
// sembró en el catálogo del container, que es el mismo que la sala resuelve.
function options(
  matchId: string,
  participants: readonly MatchParticipant[] = defaultParticipants,
): CreateMatchRequest {
  return {
    mode: "CASUAL",
    matchId,
    gameModeId: CASUAL_2P.uuid,
    participants: [...participants],
    seed: "seed",
    teamAssignment: "SEAT_ORDER",
    rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  };
}

async function configOfRoom(testServer: ColyseusTestServer, roomId: string) {
  const response = await fetch(`http://127.0.0.1:${portOf(testServer)}/config/${roomId}`);
  return (await response.json()) as { pointsToWin: number; entryFee: number; prize: number };
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
