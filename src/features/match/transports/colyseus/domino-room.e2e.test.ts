import { gameModes, rootContainer } from "@/di-container";
import {
  type ParticipantInput,
  bootTestServer,
  casualTable,
  mintToken,
  participantOf,
  waitUntil,
} from "@/tests/e2e";
import { ColyseusSDK } from "@colyseus/sdk";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MatchState } from "../../core/state";
import type { HistoryReader } from "../../network/history";
import type { CreateMatchRequest, MatchParticipant } from "../match-contract";
import { MatchRegistry } from "../match-registry";
import type { DominoRoom } from "./domino-room";

let server: ColyseusTestServer | undefined;

beforeAll(async () => {
  server = await bootTestServer(2584);
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
    expect(room.clients[0]?.auth).toEqual({ userId: "a", token });
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

  // UNA SALA QUE NO TERMINÓ DE NACER NO TIENE PARTIDA QUE ABORTAR. Desde `@colyseus/core` 0.18.14
  // un `onCreate` que lanza DISPONE la sala y corre `onDispose` —antes la dejaba viva y muda—, así
  // que acá llega una sala a medio armar. Sin la guarda, el `notifier` ya existe y el cierre emite
  // `MATCH_ABORTED`: un reembolso, un resumen y un cooldown de una mesa donde nadie se sentó. El
  // `register` es el último `await` de `onCreate` y el que falla de verdad —Redis caído al nacer—.
  it("no aborta una sala cuyo onCreate falló después de armar el motor", async () => {
    const testServer = requiredServer();
    const matchId = "match-half-born";
    const register = vi
      .spyOn(MatchRegistry.prototype, "register")
      .mockRejectedValueOnce(new Error("almacén caído"));
    const remove = vi.spyOn(MatchRegistry.prototype, "remove");
    try {
      await expect(testServer.createRoom<DominoRoom>("domino", options(matchId))).rejects.toThrow(
        /almacén caído/,
      );
      // `remove` es lo último de `onDispose`: llegar ahí es haber pasado por la guarda.
      await waitUntil(() => remove.mock.calls.length > 0);
      expect(await historyTypes(matchId)).not.toContain("MATCH_ABORTED");
    } finally {
      register.mockRestore();
      remove.mockRestore();
    }
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

  // `sub` ES LA IDENTIDAD, igual que en truco. La plataforma que emitió el token ya no forma parte
  // de la llave del asiento: el backend principal entrega un id global y el juego no lo reinterpreta.
  it("usa el sub como identidad y no la plataforma del token", async () => {
    const testServer = requiredServer();
    const participants = [
      { userId: "a", displayName: "Ada", currency: "VES" },
      { userId: "b", displayName: "Lin", currency: "USD" },
    ] as const;
    const room = await testServer.createRoom<DominoRoom>(
      "domino",
      options("match-platforms", participants),
    );
    const a = await connect(testServer, room, "a");
    const b = await connect(testServer, room, "b");

    expect(room.clients.map((client) => client.userData)).toEqual(
      expect.arrayContaining([{ playerId: "seat-1" }, { playerId: "seat-2" }]),
    );

    const outsider = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
    outsider.auth.token = tokenOf("c");
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

  // LA MESA DE CUATRO NACE, y hasta este incremento se rechazaba antes de génesis: `settlementOf`
  // exigía exactamente un ganador, así que el final de una mesa de cuatro lanzaba DESPUÉS del
  // veredicto —sin premio y sin reembolso, plata trabada—. La abrió la regla de reparto de v1.
  it("crea la sala de cuatro y reparte los cuatro asientos", async () => {
    const testServer = requiredServer();
    const cuatro = await gameModes.create({
      name: "clasica-4p",
      playersQuantity: 4,
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });

    const room = await testServer.createRoom<DominoRoom>("domino", {
      ...options("match-4p", [
        ...defaultParticipants,
        { userId: "c", displayName: "C", currency: "VES" },
        { userId: "d", displayName: "D", currency: "VES" },
      ]),
      gameModeId: cuatro.uuid,
    });

    const state = room.state as MatchState;
    expect(state.players.map(({ playerId }) => playerId)).toEqual([
      "seat-1",
      "seat-2",
      "seat-3",
      "seat-4",
    ]);
    // Las parejas, que es lo que distingue esta mesa de dos partidas de a dos.
    expect(state.players.map(({ teamId }) => teamId).filter((team) => team === "A")).toHaveLength(
      2,
    );
    // ⚠ SIN POZO: cuatro manos de siete agotan las 28 fichas, así que la rama nula no se instancia
    // y «no hay de dónde robar» deja de ser un estado y pasa a ser la forma del modo.
    expect(state.currentRound?.boneyard).toBeUndefined();
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
          { userId: "c", displayName: "C", currency: "VES" },
          { userId: "d", displayName: "D", currency: "VES" },
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
  { userId: "a", displayName: "A", currency: "VES" },
  { userId: "b", displayName: "B", currency: "VES" },
] as const;

// El request YA NO TRAE DINERO NI PUNTOS: los pone el modo que `src/tests/game-mode-catalog.ts`
// sembró en el catálogo del container, que es el mismo que la sala resuelve.
function options(
  matchId: string,
  participants: readonly MatchParticipant[] = defaultParticipants,
): CreateMatchRequest {
  return {
    ...casualTable(participants, "seed"),
    matchId,
    teamAssignment: "SEAT_ORDER",
  };
}

async function configOfRoom(testServer: ColyseusTestServer, roomId: string) {
  const response = await fetch(`http://127.0.0.1:${portOf(testServer)}/config/${roomId}`);
  return (await response.json()) as { pointsToWin: number; entryFee: number; prize: number };
}

// Un string es azúcar para "de la plataforma de siempre": los tests que no miden
// multiplataforma no tienen por qué escribir la pareja entera.
const tokenOf = (player: ParticipantInput) => mintToken(participantOf(player));

function requiredServer(): ColyseusTestServer {
  if (!server) throw new Error("servidor de prueba no iniciado");
  return server;
}

function portOf(testServer: ColyseusTestServer): number {
  return (testServer.server as unknown as { readonly port: number }).port;
}

async function connect(testServer: ColyseusTestServer, room: DominoRoom, player: ParticipantInput) {
  testServer.sdk.auth.token = tokenOf(player);
  return testServer.connectTo(room);
}

async function historyTypes(matchId: string): Promise<string[]> {
  return (await rootContainer.resolve<HistoryReader>("HistoryReader").of(matchId)).map(
    (entry) => entry.type,
  );
}
