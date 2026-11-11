import { rootContainer } from "@/di-container";
import {
  type ParticipantInput,
  bootTestServer,
  casualTable,
  joinAs,
  mintToken,
  participantOf,
  waitUntil,
} from "@/tests/e2e";
import { CASUAL_2P, CASUAL_4P } from "@/tests/table-modes";
import { ColyseusSDK } from "@colyseus/sdk";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GlobalDominoConfig, globalConfigWith } from "../../core/config";
import type { MatchState } from "../../core/state";
import type { HistoryReader } from "../../network/history";
import { ENABLED_SEATS, ENABLED_SEATS_TOKEN, type MatchParticipant } from "../match-contract";
import { MatchRegistry } from "../match-registry";
import type { DominoRoom } from "./domino-room";

let server: ColyseusTestServer | undefined;
let originalGlobalConfig: GlobalDominoConfig;

// EL ÚNICO PLAZO QUE ESTE ARCHIVO EJERCITA: «disponer una partida con veredicto» se mide CON la
// mesa en la pausa de presentación. Con el tick de vitest.setup.ts la pausa puede vencer antes de
// que el poll la vea.
beforeAll(async () => {
  originalGlobalConfig = rootContainer.resolve("GlobalDominoConfig");
  rootContainer.register<GlobalDominoConfig>("GlobalDominoConfig", {
    useValue: globalConfigWith({ ...originalGlobalConfig, presentingMatchMs: 300 }),
  });
  server = await bootTestServer(2584);
});

afterAll(async () => {
  await server?.cleanup();
  await server?.shutdown();
  rootContainer.register("GlobalDominoConfig", { useValue: originalGlobalConfig });
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

    // Destapadas primero: irse con la ventana de reparto abierta ANULA la partida.
    a.send("REVEAL_TILES", {});
    b.send("REVEAL_TILES", {});
    await waitUntil(() => room.state.currentRound?.phase === "PLAYING");
    a.send("ABANDON", {});
    await waitUntil(() => room.state.phase === "PRESENTING_MATCH");
    // `disconnect()` ya cierra a los dos: esperar su `leave()` después es esperar un `onLeave` que
    // pudo haber llegado antes, y entonces no llega nunca.
    await room.disconnect();

    expect(await historyTypes(matchId)).toContain("MATCH_RESOLVED");
    expect(await historyTypes(matchId)).not.toContain("MATCH_ABORTED");
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
      testServer.createRoom<DominoRoom>("domino", { ...options("match-bad"), rateId: " " }),
    ).rejects.toThrow(/rateId/);
  });

  // `sub` ES LA IDENTIDAD, igual que en truco. La plataforma que emitió el token ya no forma parte
  // de la llave del asiento: el backend principal entrega un id global y el juego no lo reinterpreta.
  it("usa el sub como identidad y no la plataforma del token", async () => {
    const testServer = requiredServer();
    const participants = [
      { userId: "a", displayName: "Ada", currency: "VES", providerId: "betaso" },
      { userId: "b", displayName: "Lin", currency: "USD", providerId: "betaso" },
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

  // EL MODO VIENE EN EL PEDIDO, y sin él no hay mesa: dominó no tiene catálogo que consultar. Los
  // rechazos en sí los mide `match-contract.test.ts` en aislamiento; acá se mide que `onCreate`
  // valide y no atrape lo que lanza.
  it("no crea la sala casual sin su modo en línea", async () => {
    const testServer = requiredServer();
    const { gameMode: _, ...withoutMode } = options("match-without-mode");

    await expect(testServer.createRoom<DominoRoom>("domino", withoutMode)).rejects.toThrow(
      /gameMode/,
    );
  });

  const fourParticipants = (): MatchParticipant[] => [
    ...defaultParticipants,
    { userId: "c", displayName: "C", currency: "VES", providerId: "betaso" },
    { userId: "d", displayName: "D", currency: "VES", providerId: "betaso" },
  ];

  // SÓLO DOMINÓ DE DOS (`ENABLED_SEATS`): la sala no abre una mesa de cuatro, ni por el modo ni por los
  // participantes, aunque el pedido le llegue sin pasar por la ruta del orquestador.
  it.each([
    ["un modo de cuatro", { gameModeId: CASUAL_4P.uuid, gameMode: CASUAL_4P.gameMode }],
    ["cuatro participantes", {}],
  ])("no crea una sala de cuatro: %s", async (_case, mode) => {
    const testServer = requiredServer();
    await expect(
      testServer.createRoom<DominoRoom>("domino", {
        ...options("match-4p-refused", fourParticipants()),
        ...mode,
      }),
    ).rejects.toThrow();
  });

  // EL MOTOR SÍ SABE JUGAR DE CUATRO, y se sigue midiendo: con las mesas de cuatro habilitadas por el
  // container —lo que hace sólo el arnés de los E2E—, la sala la abre.
  describe("con las mesas de cuatro habilitadas (sólo los tests)", () => {
    beforeAll(() => rootContainer.register(ENABLED_SEATS_TOKEN, { useValue: [2, 4] }));
    afterAll(() => rootContainer.register(ENABLED_SEATS_TOKEN, { useValue: ENABLED_SEATS }));

    // LA MESA DE CUATRO NACE, y hasta este incremento se rechazaba antes de génesis: `payoutOf`
    // exigía exactamente un ganador, así que el final de una mesa de cuatro lanzaba DESPUÉS del
    // veredicto —sin premio y sin reembolso, plata trabada—. La abrió la regla de reparto de v1.
    it("crea la sala de cuatro y reparte los cuatro asientos", async () => {
      const testServer = requiredServer();

      const room = await testServer.createRoom<DominoRoom>("domino", {
        ...options("match-4p", fourParticipants()),
        gameModeId: CASUAL_4P.uuid,
        gameMode: CASUAL_4P.gameMode,
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
          options("match-seat-mismatch", fourParticipants()),
        ),
      ).rejects.toThrow(/SEAT_COUNT_MISMATCH/);
    });
  });

  // CADA MESA ES SU MODO EN LÍNEA, aunque dos nombren el mismo `gameModeId`: el orquestador edita el
  // modo entre una mesa y la siguiente, y la que ya se cobró conserva los números con los que nació.
  // Sin esto —con una sala que recordara los números por `gameModeId`— un cambio de precio
  // reescribiría la economía de las partidas en curso.
  it("toma los números de su modo en línea: otra mesa del mismo modo editado no la cambia", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-frozen-mode"));

    expect(room.state.pointsToWin).toBe(100);
    expect(await configOfRoom(testServer, room.roomId)).toMatchObject({
      gameModeId: CASUAL_2P.uuid,
      pointsToWin: 100,
      currency: "UC",
      entryFee: "125.0000",
      prize: "250.0000",
      betLevels: [],
    });

    const nueva = await testServer.createRoom<DominoRoom>("domino", {
      ...options("match-after-edit"),
      gameMode: { ...CASUAL_2P.gameMode, pointsToWin: 7, entryFee: 1, prize: 2 },
    });
    expect(nueva.state.pointsToWin).toBe(7);
    expect(await configOfRoom(testServer, nueva.roomId)).toMatchObject({
      gameModeId: CASUAL_2P.uuid,
      pointsToWin: 7,
      currency: "UC",
      entryFee: "1.0000",
      prize: "2.0000",
    });

    // Los números van como LITERAL: la primera mesa sigue con los suyos.
    expect(room.state.pointsToWin).toBe(100);
    expect(await configOfRoom(testServer, room.roomId)).toMatchObject({
      pointsToWin: 100,
      currency: "UC",
      entryFee: "125.0000",
      prize: "250.0000",
    });

    await Promise.all([room.disconnect(), nueva.disconnect()]);
  });

  // EL MENSAJE `config`: la sala manda su configuración pública, el asiento de quien lo recibe y
  // `serverNow` a cada uno que entra y a cada uno que vuelve. Es la única vía: no hay ruta HTTP. El handler se
  // registra SIN `await` en el medio después del join: lo que la sala manda en `onJoin` llega apenas
  // el cliente confirma la entrada, y el comodín de `src/tests/e2e.ts` se tragaría lo que nadie
  // escucha todavía.
  it("manda la config pública con serverNow al entrar y al volver", async () => {
    const testServer = requiredServer();
    const room = await testServer.createRoom<DominoRoom>("domino", options("match-config-msg"));
    const before = Date.now();
    // `joinById` y no `connectTo`: éste espera además el estado inicial, y para entonces el
    // mensaje ya llegó y se lo llevó el comodín.
    const a = await joinAs(testServer, room.roomId, "a");
    const received: Record<string, unknown>[] = [];
    a.onMessage("config", (message: Record<string, unknown>) => {
      received.push(message);
    });
    await waitUntil(() => received.length === 1);

    // EL MISMO DTO QUE EL REGISTRO ESTAMPA, más el asiento propio y el reloj.
    const stamped = await rootContainer.resolve(MatchRegistry).publicConfigOf(room.roomId);
    const seat = { playerId: "seat-1" };
    expect(received[0]).toEqual({ ...stamped, seat, serverNow: expect.any(Number) });
    expect(received[0]?.serverNow).toBeGreaterThanOrEqual(before);
    expect(received[0]).toMatchObject({ isFreeRoom: false, enableBots: false, betLevels: [] });
    expect(JSON.stringify(received[0])).not.toContain("seed");

    // UN BACHE DE RED: el SDK reintenta sobre la misma instancia, con los handlers intactos, y la
    // sala vuelve a mandar la config en `onReconnect`.
    a.reconnection.minUptime = 0;
    let reconnected = false;
    a.onReconnect(() => {
      reconnected = true;
    });
    void a.leave(false);
    await waitUntil(() => reconnected, 5_000);
    await waitUntil(() => received.length === 2, 3_000);
    expect(received[1]).toEqual({ ...stamped, seat, serverNow: expect.any(Number) });
    expect(received[1]?.serverNow).toBeGreaterThanOrEqual(received[0]?.serverNow as number);

    await room.disconnect();
  });
});

const defaultParticipants = [
  { userId: "a", displayName: "A", currency: "VES", providerId: "betaso" },
  { userId: "b", displayName: "B", currency: "VES", providerId: "betaso" },
] as const;

// El dinero y los puntos los trae el modo en línea de `src/tests/table-modes.ts` (`CASUAL_2P`).
function options(
  matchId: string,
  participants: readonly MatchParticipant[] = defaultParticipants,
): ReturnType<typeof casualTable> {
  return {
    ...casualTable(participants, "seed"),
    matchId,
    teamAssignment: "SEAT_ORDER",
  };
}

// LA CONFIG PÚBLICA QUE EL REGISTRO ESTAMPÓ: la base del mensaje `config` (no hay ruta HTTP).
async function configOfRoom(_testServer: ColyseusTestServer, roomId: string) {
  const config = await rootContainer.resolve(MatchRegistry).publicConfigOf(roomId);
  if (!config) throw new Error(`la sala ${roomId} no está en el registro`);
  return config;
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
