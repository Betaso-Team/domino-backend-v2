import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boneyardCountOf } from "../core/engine/state-projections.js";
import {
  type SeatedMatch,
  act,
  bootServer,
  historyOf,
  legalPlayFor,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

const MATCH_ID = "m-g1-g2";

let server: ColyseusTestServer;
let match: SeatedMatch;

// La partida se juega UNA vez, en el hook, y los cuatro `it` afirman sobre lo que quedó.
// Jugarla dentro del primero ataría a los otros tres a su orden: `vitest -t "historial"`
// correría solo y leería un historial vacío, y una caída del primero se manifestaría como
// tres fallos más que no señalan la causa.
beforeAll(async () => {
  server = await bootServer(2587);
  match = await seatPair(server, ["g1", "g2"], "seed-partida-completa");
  await revealHands(match);

  // Tope de seguridad: una partida a 100 puntos no debería pasar de esto, y si
  // lo pasa es un bucle. No se corta acá con un throw: agotar la vuelta deja la fase
  // sin terminar y el primer test la reporta como lo que es, un fallo con su aserción.
  for (let turns = 0; turns < 3_000; turns += 1) {
    if (match.serverState.phase === "FINISHED") break;
    const played = await playOneTurn(match);
    if (!played) {
      // Fuera de PLAYING: o es la pausa de la mano, o la de la partida. Los dos
      // plazos son cortos en test, así que se espera a que el reloj los venza.
      await waitUntil(
        () =>
          match.serverState.currentRound?.phase === "PLAYING" ||
          match.serverState.phase === "FINISHED",
        3_000,
      );
    }
  }
}, 30_000);

afterAll(async () => {
  await server.shutdown();
});

// Juega una jugada legal del que tiene el turno, o roba, o pasa. Devuelve false
// cuando la ronda dejó de estar en PLAYING.
//
// Espera con `act`, que compara la FIRMA del estado. El conteo total de fichas NO sirve
// de señal: jugar mueve una de la mano al tablero y robar la mueve del pozo a la mano, así
// que board + hand + boneyard es un invariante de la ronda y nunca se mueve. La firma, en
// cambio, incluye el plazo vigente, y los tres verbos lo re-estampan.
async function playOneTurn(seated: SeatedMatch): Promise<boolean> {
  const round = seated.serverState.currentRound;
  if (!round || round.phase !== "PLAYING") return false;

  const playerId = round.currentTurn?.playerId;
  if (!playerId) return false;

  const play = legalPlayFor(seated.serverState, playerId);
  if (play) {
    await act(seated, playerId, "PLAY_TILE", play);
  } else if (boneyardCountOf(round) > 0) {
    await act(seated, playerId, "DRAW_TILE");
  } else {
    await act(seated, playerId, "PASS");
  }
  return true;
}

describe("partida 2P completa", () => {
  it("se jugó de punta a punta hasta que hubo veredicto", async () => {
    expect(match.serverState.phase).toBe("FINISHED");
    const scoreboard = match.serverState.scoreboard;
    expect(scoreboard).toBeDefined();
    expect(Math.max(scoreboard?.teamA ?? 0, scoreboard?.teamB ?? 0)).toBeGreaterThanOrEqual(
      match.serverState.pointsToWin,
    );
    expect(match.serverState.pastRounds.length).toBeGreaterThan(0);
  });

  it("el historial de esa partida cierra con el veredicto y sin huecos de seq", async () => {
    const entries = historyOf(MATCH_ID);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    // El veredicto NO es la última línea: `MATCH_RESOLVED` abre la presentación de la
    // partida, y lo último que queda escrito es el vencimiento de ESA ventana — el mismo
    // que apaga la mesa. Afirmar solo sobre `at(-1)` diría que el registro se corta antes
    // del apagado, que es justo el hueco que el historial existe para no dejar.
    expect(entries.slice(-2).map((entry) => entry.type)).toEqual([
      "MATCH_RESOLVED",
      "DEADLINE_EXPIRED",
    ]);
  });

  it("cada DEADLINE_EXPIRED quedó registrado como evento del sistema", async () => {
    const entries = historyOf(MATCH_ID);
    const expirations = entries.filter((entry) => entry.type === "DEADLINE_EXPIRED");
    expect(expirations.length).toBeGreaterThan(0);

    entries.forEach((entry, index) => {
      if (entry.type !== "DEADLINE_EXPIRED") return;
      expect(entry.source).toBe("SYSTEM");
      expect(entry.kind).toBe("EVENT");
      // ESTA RAMA NO SE EJERCE ACÁ, y el título del test no la promete. La relación
      // existe en producción —`MatchDriver.timeout()` con `kind === "TURN"` retira al
      // que no jugó y emite el ABANDON del sistema (match/driver.ts:70-80)—, pero en una
      // corrida sana de este E2E el bot juega siempre a tiempo y NINGÚN plazo de turno
      // vence: los vencimientos reales de esta partida son 6 PRESENTING_ROUND y 1
      // PRESENTING_MATCH, cero TURN. Queda como red por si el bot se atrasa; la
      // cobertura de verdad de ese camino es la Tarea 22, con un jugador que se cuelga
      // a propósito. Los de las presentaciones no ejecutan verbo ninguno —arrancan la
      // ronda siguiente o apagan la mesa—, así que exigirles uno sería inventar el
      // contrato en vez de medirlo.
      if (entry.payload.kind !== "TURN") return;
      const next = entries[index + 1];
      expect(next?.source).toBe("SYSTEM");
      expect(next?.type).toBe("ABANDON");
    });
  });

  it("ningún comando quedó registrado con source SYSTEM ni al revés", async () => {
    const entries = historyOf(MATCH_ID);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry.kind === "COMMAND") expect(entry.source).toBe("PLAYER");
      if (entry.kind === "EVENT") expect(entry.source).toBe("SYSTEM");
    }
  });
});
