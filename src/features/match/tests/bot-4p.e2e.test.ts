import { gameModes, rootContainer } from "@/di-container";
import {
  type ParticipantInput,
  bootTestServer,
  casualTable,
  mintToken,
  participantOf,
} from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state";
import type { HistoryReader } from "../network";
import type { DominoRoom } from "../transports/colyseus/domino-room";

// LA MESA DE CUATRO DE PUNTA A PUNTA, y lo que cierra el círculo: que la MÁQUINA JUEGUE. Las
// capas de abajo miden la decisión de sentarla (`bot-seating.int.test.ts`) y qué ficha elige
// (`rules/tests/bot.test.ts`); acá se mide lo único que ninguna de las dos puede: que alguien la
// empuje. Sin ese empuje todo lo demás está bien y la mesa se queda quieta igual.

let server: ColyseusTestServer | undefined;
let gameModeId = "";

const PARTICIPANTS = [
  { userId: "ada", displayName: "Ada", currency: "VES" },
  { userId: "lin", displayName: "Lin", currency: "VES" },
  { userId: "rex", displayName: "Rex", currency: "VES" },
  { userId: "zoe", displayName: "Zoe", currency: "VES" },
] as const;

beforeAll(async () => {
  server = await bootTestServer(2_601);
  const mode = await gameModes.create({
    name: "cuatro-con-bots",
    playersQuantity: 4,
    pointsToWin: 200,
    entryFee: 10,
    prize: 20,
    enableBots: true,
  });
  gameModeId = mode.uuid;
});

afterAll(async () => {
  await server?.shutdown();
});

const requiredServer = (): ColyseusTestServer => {
  if (!server) throw new Error("servidor de prueba no iniciado");
  return server;
};

const connect = async (room: DominoRoom, player: ParticipantInput) => {
  const testServer = requiredServer();
  testServer.sdk.auth.token = mintToken(participantOf(player));
  return testServer.connectTo(room);
};

// La mesa arranca TAPADA: `isDealWindowEnabled` está encendido en toda mesa, así que hasta que
// los cuatro mandan `REVEAL_TILES` la ronda no entra en juego y el reloj que corre es el de la
// ventana de reparto — que retira a todos, no sienta ningún bot.
const seatFour = async () => {
  const testServer = requiredServer();
  const matchId = `bots-${Date.now()}`;
  const room = await testServer.createRoom<DominoRoom>("domino", {
    ...casualTable(PARTICIPANTS, "bots-seed"),
    matchId,
    teamAssignment: "SEAT_ORDER",
    gameModeId,
  });

  const clients = [];
  for (const player of PARTICIPANTS) clients.push(await connect(room, player));
  for (const client of clients) client.send("REVEAL_TILES", {});
  await room.waitForNextPatch();
  await room.waitForNextPatch();
  const state = room.state as MatchState;
  // SE VA EL QUE TIENE EL TURNO, y no uno cualquiera: la máquina juega cuando LE TOCA, así que
  // retirar a otro deja la mesa esperando a un humano que en este test no manda nada. Es además
  // el caso real —el que se va suele ser el que está trabado— y el único donde el reloj de la
  // máquina se puede observar sin conducir la partida entera a mano.
  const onTurn = state.currentRound?.currentTurn?.playerId ?? "";
  const seatIndex = state.players.findIndex(({ playerId }) => playerId === onTurn);
  return { room, clients, matchId, state, onTurn, quitter: clients[seatIndex] };
};

describe("la mesa de cuatro con máquinas", () => {
  it("sienta las cuatro sillas en dos parejas y sin pozo", async () => {
    const { room, state } = await seatFour();

    expect(state.players.length).toBe(4);
    expect(state.players.filter(({ teamId }) => teamId === "A").length).toBe(2);
    // Cuatro manos de siete agotan las 28 fichas: la rama nula no se instancia.
    expect(state.currentRound?.boneyard).toBeUndefined();
    expect(state.currentRound?.phase).toBe("PLAYING");

    await room.disconnect();
  });

  // ⚠ EL TEST QUE JUSTIFICA EL INCREMENTO ENTERO. Se va uno, y la partida NO se cierra: su
  // asiento pasa a la máquina, que juega sola. Todo lo de abajo —la bandera, la política, el
  // empuje, el historial— tiene que estar puesto para que este `expect` pase.
  it("el que se va deja una máquina jugando, y la mesa sigue", async () => {
    const { room, state, onTurn, quitter } = await seatFour();
    const leaving = state.players.find(({ playerId }) => playerId === onTurn);
    const tilesBefore = state.currentRound?.board.tiles.length ?? 0;

    quitter?.send("ABANDON", {});
    await room.waitForNextPatch();

    expect(leaving?.isBot).toBe(true);
    expect(leaving?.hasAbandoned).toBe(false);
    expect(state.phase).toBe("PLAYING");

    // Y JUEGA DE VERDAD: se le da su plazo de reflexión y el tablero tiene que haberse movido.
    // Es lo único que no se puede medir sin levantar la sala — el reloj de la máquina es de la
    // RED, porque los comandos del motor son síncronos y esto tiene que esperar.
    await new Promise((resume) => setTimeout(resume, 2_500));
    expect(state.currentRound?.board.tiles.length ?? 0).toBeGreaterThan(tilesBefore);

    await room.disconnect();
  });

  // EL HISTORIAL NO MIENTE SOBRE QUIÉN JUGÓ. La jugada de la máquina se graba como acto del
  // SISTEMA y no del jugador, y esa distinción es toda la razón de que el bot no entre por el
  // router: su handler graba `"PLAYER"` por construcción. La partida que alguien va a auditar es
  // justamente ésta, la que alguien abandonó.
  it("graba la jugada de la máquina como acto del sistema", async () => {
    const { room, matchId, quitter } = await seatFour();

    quitter?.send("ABANDON", {});
    await room.waitForNextPatch();
    await new Promise((resume) => setTimeout(resume, 2_500));

    const history = await rootContainer.resolve<HistoryReader>("HistoryReader").of(matchId);
    const bySystem = history.filter((entry) => entry.source === "SYSTEM");

    expect(bySystem.map((entry) => entry.type)).toContain("PLAY_TILE");
    // Y el verbo del que se fue quedó grabado como suyo, que es la otra mitad de la distinción.
    expect(history.some((entry) => entry.source === "PLAYER" && entry.type === "ABANDON")).toBe(
      true,
    );
  });
});
