import { rootContainer } from "@/di-container";
import { env } from "@/env";
import { CASUAL_2P } from "@/tests/game-mode-catalog";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GlobalDominoConfig, globalConfigWith } from "../core/config";
import type { MatchState } from "../core/state";
import {
  type SeatedMatch,
  act,
  bootServer,
  casualTable,
  clientOf,
  historyOf,
  linesOf,
  mintToken,
  participantOf,
  playOneTurn,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

let server: ColyseusTestServer;

const HISTORY_URL = (matchId: string) =>
  `http://localhost:2585/internal/matches/${matchId}/history`;
// La misma llave que vitest.setup.ts le pone al entorno: es la credencial de la consola
// de soporte, no un dato de la partida.
const INTERNAL_HEADERS = { "x-internal-api-key": env.adminApiKey ?? "" };

let originalGlobalConfig: GlobalDominoConfig;

// EL ÚNICO PLAZO QUE ESTE ARCHIVO EJERCITA: el abandono tiene que dejar la mesa EN la pausa de
// presentación, y se afirma. Con el tick de vitest.setup.ts la pausa puede vencer antes de que el
// poll de `act` la vea.
beforeAll(async () => {
  originalGlobalConfig = rootContainer.resolve("GlobalDominoConfig");
  rootContainer.register<GlobalDominoConfig>("GlobalDominoConfig", {
    useValue: globalConfigWith({ ...originalGlobalConfig, presentingMatchMs: 300 }),
  });
  server = await bootServer(2585);
});

afterAll(async () => {
  await server.shutdown();
  rootContainer.register("GlobalDominoConfig", { useValue: originalGlobalConfig });
});

// HASTA LA PAUSA DEL VEREDICTO y no más: `playUntilDecided` sigue hasta la ventana o el terminal,
// y lo que se mide acá pasa ADENTRO de esa pausa.
async function playUntilVerdict(match: SeatedMatch): Promise<void> {
  for (let turns = 0; turns < 3_000; turns += 1) {
    if (match.serverState.phase === "PRESENTING_MATCH") return;
    if (!(await playOneTurn(match))) {
      await waitUntil(
        () =>
          match.serverState.currentRound?.phase === "PLAYING" ||
          match.serverState.phase === "PRESENTING_MATCH",
        3_000,
      );
    }
  }
}

// Muestrea las fases camino al terminal: una ventana que se abriera quedaría arriba 300 ms.
async function phasesUntilFinished(match: SeatedMatch): Promise<Set<string>> {
  const phases = new Set<string>();
  await waitUntil(() => phases.add(match.serverState.phase).has("FINISHED"), 5_000);
  return phases;
}

describe("ciclo de vida de una partida", () => {
  it("la partida arranca sola al ocuparse el último asiento", async () => {
    const match = await seatPair(server, ["u1", "u2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    expect(match.serverState.startedAt).toBeGreaterThan(0);
    expect(match.serverState.players.map((player) => player.playerId)).toEqual([
      "seat-1",
      "seat-2",
    ]);
    expect(match.serverState.players.map((player) => player.teamId)).toEqual(["A", "B"]);
  });

  it("abandonar cierra la partida por forfeit, y el historial queda intercalado", async () => {
    const match = await seatPair(server, ["a1", "a2"]);
    // Destapadas primero: irse con la ventana de reparto abierta ANULA, no da forfeit.
    await revealHands(match);

    await act(match, "a1", "ABANDON");
    expect(match.serverState.phase).toBe("PRESENTING_MATCH");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

    expect(await linesOf("m-a1-a2")).toEqual([
      "PLAYER REVEAL_TILES",
      "PLAYER REVEAL_TILES",
      "PLAYER ABANDON",
      "SYSTEM MATCH_RESOLVED",
      "SYSTEM DEADLINE_EXPIRED",
    ]);
    const resolved = (await historyOf("m-a1-a2")).find((entry) => entry.type === "MATCH_RESOLVED");
    expect(resolved?.payload).toEqual({ winnerTeamId: "B", reason: "ABANDONMENT" });
  });

  it("el seq no tiene huecos y es estrictamente creciente", async () => {
    const match = await seatPair(server, ["s1", "s2"]);
    await revealHands(match);
    await act(match, "s1", "ABANDON");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

    const seqs = (await historyOf("m-s1-s2")).map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  // DESDE EL VEREDICTO, IRSE ES IRSE (truco `0960663`): el que se va en la pausa del final no vuelve
  // a esta mesa, así que la ventana de revancha no se abre ni apagada.
  it("si alguien se va en la pausa del veredicto, la ventana de revancha no se abre", async () => {
    const match = await seatPair(server, ["vs1", "vs2"]);
    await revealHands(match);
    await playUntilVerdict(match);

    await clientOf(match, "vs2").leave();

    expect(await phasesUntilFinished(match)).not.toContain("REMATCH_WINDOW");
  }, 60_000);

  // Y una recarga no es excepción: la caída cuenta igual que la salida.
  it("si alguien se cae en la pausa del veredicto, la ventana tampoco se abre", async () => {
    const match = await seatPair(server, ["vd1", "vd2"]);
    await revealHands(match);
    await playUntilVerdict(match);

    const client = clientOf(match, "vd2");
    client.reconnection.enabled = false;
    void client.leave(false);

    expect(await phasesUntilFinished(match)).not.toContain("REMATCH_WINDOW");
  }, 60_000);

  // El control: sin nadie que se vaya, la misma mesa sí abre la ventana (apagada).
  it("si nadie se va, la ventana se abre", async () => {
    const match = await seatPair(server, ["vc1", "vc2"]);
    await revealHands(match);
    await playUntilVerdict(match);

    expect(await phasesUntilFinished(match)).toContain("REMATCH_WINDOW");
  }, 60_000);

  it("un verbo desconocido se rechaza y no entra al historial", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    const illegal: unknown[] = [];
    const r1 = clientOf(match, "r1");
    r1.onMessage("illegal", (payload) => illegal.push(payload));
    r1.send("DROP_TABLE", {});

    await waitUntil(() => illegal.length > 0);
    expect(illegal[0]).toEqual({ code: "UNKNOWN_COMMAND" });
    expect(await historyOf("m-r1-r2")).toHaveLength(0);
    expect(match.serverState.phase).toBe("PLAYING");
  });

  it("un mensaje llamado toString no mata la mesa", async () => {
    const match = await seatPair(server, ["p1", "p2"]);
    const illegal: unknown[] = [];
    const p1 = clientOf(match, "p1");
    p1.onMessage("illegal", (payload) => illegal.push(payload));
    p1.send("toString", {});

    await waitUntil(() => illegal.length > 0);
    expect(illegal[0]).toEqual({ code: "UNKNOWN_COMMAND" });
    expect(match.serverState.phase).toBe("PLAYING");
  });

  it("una segunda conexión del mismo asiento desplaza a la primera", async () => {
    const match = await seatPair(server, ["d1", "d2"]);
    server.sdk.auth.token = mintToken(participantOf("d1"));
    await server.sdk.joinById(match.roomId);
    await waitUntil(() => server.getRoomById(match.roomId).clients.length === 2);

    // Ni caída ni regreso: para el rival, d1 nunca se fue (truco `b90840b`).
    expect(
      (await linesOf("m-d1-d2")).filter(
        (line) => line.includes("PLAYER_DISCONNECTED") || line.includes("PLAYER_RECONNECTED"),
      ),
    ).toEqual([]);
  });

  it("la misma cuenta dos veces no completa la mesa: arranca cuando se sientan todos", async () => {
    const room = await server.createRoom("domino", casualTable(["dup1", "dup2"]));
    server.sdk.auth.token = mintToken(participantOf("dup1"));
    await server.connectTo(room);
    await server.connectTo(room);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const startedAt = () => (server.getRoomById(room.roomId).state as MatchState).startedAt;
    expect(startedAt()).toBe(0);

    server.sdk.auth.token = mintToken(participantOf("dup2"));
    await server.connectTo(room);
    await waitUntil(() => startedAt() > 0);
  });

  it("quien no tiene asiento no entra", async () => {
    const room = await server.createRoom("domino", casualTable(["x1", "x2"]));
    server.sdk.auth.token = mintToken(participantOf("x1"));
    await server.connectTo(room);
    server.sdk.auth.token = mintToken(participantOf("intruso"));

    await expect(server.connectTo(room)).rejects.toThrow();
    expect(server.getRoomById(room.roomId)).toBeDefined();
  });

  it("sin token no entra", async () => {
    const room = await server.createRoom("domino", casualTable(["y1", "y2"]));
    await server.sdk.auth.signOut();

    await expect(server.connectTo(room)).rejects.toThrow();
  });

  it("el endpoint de config responde el DTO sin seed", async () => {
    const match = await seatPair(server, ["c1", "c2"], "seed-secretisimo");
    const response = await fetch(`http://localhost:2585/config/${match.roomId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("seed-secretisimo");
    expect(JSON.parse(body)).toEqual({
      matchId: "m-c1-c2",
      // EL UUID DEL MODO RESUELTO, y ya no el nombre que el request traía: desde la Tarea 10 el
      // snapshot guarda lo que el catálogo devolvió. Sale del modo sembrado y no de un literal
      // porque el repositorio de memoria lo genera al crearlo.
      gameModeId: CASUAL_2P.uuid,
      seats: ["seat-1", "seat-2"],
      // LOS TRES NÚMEROS SALEN DEL CATÁLOGO y siguen siendo los mismos: van como literal para que
      // este endpoint quede pineado contra el modo y no contra sí mismo.
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
      serverNow: expect.any(Number),
    });
  });

  it("el config trae una muestra actual del reloj del servidor", async () => {
    const match = await seatPair(server, ["t1", "t2"]);
    const before = Date.now();
    const body = (await (await fetch(`http://localhost:2585/config/${match.roomId}`)).json()) as {
      serverNow: number;
    };
    const after = Date.now();

    expect(body.serverNow).toBeGreaterThanOrEqual(before);
    expect(body.serverNow).toBeLessThanOrEqual(after);
  });

  // EL PAR es lo que prueba que el schema hace el trabajo, no una de las dos mitades sola.
  // 400 y 404 dicen cosas distintas y el cliente las trata distinto: uno es "pediste mal",
  // el otro "eso no existe". Sin schema las dos formas caían en el mismo 404 —el id iba
  // derecho al `Map.get` del registry—, y el cliente no tenía cómo distinguir un id que
  // escribió mal de una mesa que ya murió.
  it("un roomId inexistente es 404 y uno de forma imposible es 400", async () => {
    const inexistente = await fetch("http://localhost:2585/config/no-existe");
    const conPuntos = await fetch("http://localhost:2585/config/tiene.puntos");
    const larguisimo = await fetch(`http://localhost:2585/config/${"x".repeat(65)}`);

    expect(inexistente.status).toBe(404);
    expect(conPuntos.status).toBe(400);
    expect(await conPuntos.json()).toMatchObject({ code: "MALFORMED" });
    expect(larguisimo.status).toBe(400);
  });

  // El matchId entra del cliente y SALE en la respuesta (`{ matchId, entries }`): sin
  // schema es entrada cruda reflejada. El salto de línea es el caso que importa —viaja
  // como `%0A`, Express lo decodifica, y un id con control adentro termina en el log y en
  // el cuerpo—, así que se corta antes de leer el historial.
  it("un matchId con caracteres de control es 400 en el endpoint interno", async () => {
    const response = await fetch(HISTORY_URL("m-con%0Asalto"), { headers: INTERNAL_HEADERS });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MALFORMED" });
  });

  // EL ORDEN es el contrato: primero se prueba quién sos, después qué mandaste. Si la
  // validación corriera antes del guard, un anónimo podría distinguir "forma inválida" de
  // "forma válida" en una ruta que no tiene derecho a tocar — un oráculo gratis sobre el
  // formato de los ids internos.
  it("sin llave, un matchId inválido sigue siendo 401 y no 400", async () => {
    const response = await fetch(HISTORY_URL("m-con%0Asalto"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  // El endpoint de SOPORTE: es de dónde sale el historial que después se rebobina.
  // Se indexa por matchId y no por roomId a propósito — la sala muere y la partida no.
  it("el endpoint interno devuelve el historial de la partida", async () => {
    const match = await seatPair(server, ["h1", "h2"]);
    await revealHands(match);

    const response = await fetch(HISTORY_URL("m-h1-h2"), { headers: INTERNAL_HEADERS });
    const body = (await response.json()) as { matchId: string; entries: { type: string }[] };

    expect(response.status).toBe(200);
    expect(body.matchId).toBe("m-h1-h2");
    expect(body.entries.map((entry) => entry.type)).toEqual(["REVEAL_TILES", "REVEAL_TILES"]);
  });

  it("una partida sin historial es 404 y no un cuerpo vacío", async () => {
    const response = await fetch(HISTORY_URL("m-no-existe"), { headers: INTERNAL_HEADERS });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  // La llave NO es opcional ni "cuando exista": el matchId es enumerable y esto sirve el
  // registro completo de una mesa. Sin credencial es 401 —el recurso existe, lo que falta
  // es la llave— y el cuerpo no dice nada de si la partida existe o no.
  //
  // Las DOS llaves malas son dos ramas distintas del guard, y una sola no cubre la otra:
  // la corta muere en el `a.length === b.length` —que existe porque `timingSafeEqual` LANZA
  // con buffers de distinto largo—, y la del MISMO LARGO es la única que llega a la
  // comparación en tiempo constante. Se deriva de `env.adminApiKey` y no se escribe a
  // mano: una constante literal deja de medir el largo real el día que la llave de
  // vitest.setup.ts cambie, y el test seguiría verde midiendo la rama equivocada. Así
  // estaba antes —37 caracteres contra una llave de 42— y por eso se corrigió.
  it("el endpoint interno rechaza sin llave, con una corta y con una del mismo largo", async () => {
    const match = await seatPair(server, ["k1", "k2"]);
    await revealHands(match);

    const mismoLargo = "x".repeat(env.adminApiKey?.length ?? 0);
    const sinLlave = await fetch(HISTORY_URL("m-k1-k2"));
    const conLlaveCorta = await fetch(HISTORY_URL("m-k1-k2"), {
      headers: { "x-internal-api-key": "corta" },
    });
    const conLlaveDelMismoLargo = await fetch(HISTORY_URL("m-k1-k2"), {
      headers: { "x-internal-api-key": mismoLargo },
    });

    expect(mismoLargo).toHaveLength(env.adminApiKey?.length ?? 0);
    expect(mismoLargo).not.toBe(env.adminApiKey);
    expect(sinLlave.status).toBe(401);
    expect(await sinLlave.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(conLlaveCorta.status).toBe(401);
    expect(conLlaveDelMismoLargo.status).toBe(401);
  });
});
