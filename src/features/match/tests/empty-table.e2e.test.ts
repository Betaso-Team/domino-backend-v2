import { rootContainer } from "@/di-container";
import { matchMaker } from "@colyseus/core";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GlobalConfigSource, globalConfigWith } from "../core/config";
import {
  type SeatedMatch,
  bootServer,
  clientOf,
  historyOf,
  linesOf,
  playOneTurn,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

// LA MESA VACÍA NO ES UNA PARTIDA TERMINADA, portado de truco (`102a06b`). Colyseus dispone una sala
// en cuanto se va su último socket y se vencen sus reconexiones pendientes; si los dos jugadores se
// caen y la ventana de reconexión es más corta que lo que tarda el reloj en decidir, la sala moría
// con `MATCH_ABORTED INTERRUPTED` —reembolso y nadie a quien volver— en vez de que el reloj retire
// al que tenía el turno, que es un veredicto. Con los 120 s de producción no se veía porque el turno
// (60 + 30 s) vence antes; con la ventana en su mínimo editable (10 s) sí.
//
// LOS PLAZOS DE LA SUITE NO ALCANZAN PARA VERLO: vencida la ventana, Colyseus espera UN SEGUNDO más
// antes de disponer (`resetAutoDisposeTimeout()` en el rechazo de la reconexión, `Room.mjs`), y con
// 0,5 s de ventana el turno de 600 + 300 ms y el reparto de 800 ms deciden antes. Acá el turno y el
// reparto duran 3 s: la ventana más ese segundo vence primero, que es el caso de producción con la
// ventana en 10 s y el turno en 60 + 30 s.
const WINDOW_SECONDS = 0.5;
const CLOCK_MS = 3_000;
let originalSource: GlobalConfigSource;
let server: ColyseusTestServer;

beforeAll(async () => {
  originalSource = rootContainer.resolve<GlobalConfigSource>("GlobalConfigSource");
  const base = originalSource();
  rootContainer.register<GlobalConfigSource>("GlobalConfigSource", {
    useValue: () =>
      globalConfigWith({
        ...base,
        reconnectionWindowSeconds: WINDOW_SECONDS,
        turnTimeoutMs: CLOCK_MS,
        dealingTimeoutMs: CLOCK_MS,
      }),
  });
  server = await bootServer(2653);
});

afterAll(async () => {
  await server.shutdown();
  rootContainer.register("GlobalConfigSource", { useValue: originalSource });
});

const roomAlive = async (match: SeatedMatch) =>
  (await matchMaker.query({ roomId: match.roomId })).length === 1;

async function bothGone(match: SeatedMatch, users: readonly string[]): Promise<void> {
  for (const userId of users) clientOf(match, userId).reconnection.enabled = false;
  await Promise.all(users.map((userId) => clientOf(match, userId).leave(false)));
}

describe("los dos se van y la ventana de reconexión vence antes que el reloj", () => {
  it("la sala sigue viva, el reloj da el veredicto y recién ahí se cierra", async () => {
    const users = ["et1", "et2"] as const;
    const match = await seatPair(server, users);
    const matchId = match.config.matchId;
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await revealHands(match);
    await playOneTurn(match);

    await bothGone(match, users);
    // Pasada la ventana y el segundo de Colyseus (1,5 s), antes del veredicto (3 s + la reserva).
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await roomAlive(match)).toBe(true);

    await waitUntil(async () => (await linesOf(matchId)).includes("SYSTEM MATCH_RESOLVED"), 8_000);
    await waitUntil(async () => !(await roomAlive(match)), 5_000);
    expect(await linesOf(matchId)).not.toContain("SYSTEM MATCH_ABORTED");
  }, 15_000);

  it("en el reparto, la mesa espera al plazo y sale anulada por no levantar, no interrumpida", async () => {
    const users = ["et3", "et4"] as const;
    const match = await seatPair(server, users);
    const matchId = match.config.matchId;
    await waitUntil(() => match.serverState.phase === "PLAYING");

    await bothGone(match, users);
    await waitUntil(async () => !(await roomAlive(match)), 5_000);
    expect(
      (await historyOf(matchId)).find((entry) => entry.type === "MATCH_ABORTED")?.payload,
    ).toEqual({ reason: "TILES_NOT_SEEN" });
  }, 15_000);
});
