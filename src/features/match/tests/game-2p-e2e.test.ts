import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardEndsOf } from "../core/engine/round/board-ends.js";
import { playableSides } from "../core/engine/round/playable.js";
import { boneyardCountOf } from "../core/engine/state-projections.js";
import {
  type SeatedMatch,
  act,
  bootServer,
  historyOf,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2587);
});

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
async function playOneTurn(match: SeatedMatch): Promise<boolean> {
  const round = match.serverState.currentRound;
  if (!round || round.phase !== "PLAYING") return false;

  const playerId = round.currentTurn?.playerId;
  if (!playerId) return false;
  const hand = match.serverState.players.find((p) => p.playerId === playerId)?.hand;
  if (!hand) return false;

  const ends = boardEndsOf(round.board);
  const candidate = [...hand.tiles]
    .map((tile) => ({ tile, side: playableSides(tile, ends).at(0) }))
    .find((entry) => entry.side !== undefined);

  if (candidate?.side) {
    await act(match, playerId, "PLAY_TILE", {
      left: candidate.tile.left,
      right: candidate.tile.right,
      side: candidate.side,
    });
  } else if (boneyardCountOf(round) > 0) {
    await act(match, playerId, "DRAW_TILE");
  } else {
    await act(match, playerId, "PASS");
  }
  return true;
}

describe("partida 2P completa", () => {
  it("se juega de punta a punta hasta que hay veredicto", async () => {
    const match = await seatPair(server, ["g1", "g2"], "seed-partida-completa");
    await revealHands(match);

    // Tope de seguridad: una partida a 100 puntos no debería pasar de esto, y si
    // lo pasa es un bucle y hay que verlo como fallo, no como cuelgue.
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

    expect(match.serverState.phase).toBe("FINISHED");
    const { teamA, teamB } = match.serverState.scoreboard ?? { teamA: 0, teamB: 0 };
    expect(Math.max(teamA, teamB)).toBeGreaterThanOrEqual(match.serverState.pointsToWin);
    expect(match.serverState.pastRounds.length).toBeGreaterThan(0);
  });

  it("el historial de esa partida cierra con el veredicto y sin huecos de seq", async () => {
    const entries = historyOf("m-g1-g2");
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

  it("cada DEADLINE_EXPIRED es del sistema, y el de turno trae detrás el retiro", async () => {
    const entries = historyOf("m-g1-g2");
    const expirations = entries.filter((entry) => entry.type === "DEADLINE_EXPIRED");
    expect(expirations.length).toBeGreaterThan(0);

    entries.forEach((entry, index) => {
      if (entry.type !== "DEADLINE_EXPIRED") return;
      expect(entry.source).toBe("SYSTEM");
      expect(entry.kind).toBe("EVENT");
      // Solo el plazo del TURNO tiene un verbo detrás: al vencer, el sistema retira al
      // que no jugó. Los de las presentaciones no ejecutan verbo ninguno —arrancan la
      // ronda siguiente o apagan la mesa—, así que exigirles uno sería inventar el
      // contrato en vez de medirlo.
      if (entry.payload.kind !== "TURN") return;
      const next = entries[index + 1];
      expect(next?.source).toBe("SYSTEM");
      expect(next?.type).toBe("ABANDON");
    });
  });

  it("ningún comando quedó registrado con source SYSTEM ni al revés", async () => {
    for (const entry of historyOf("m-g1-g2")) {
      if (entry.kind === "COMMAND") expect(entry.source).toBe("PLAYER");
      if (entry.kind === "EVENT") expect(entry.source).toBe("SYSTEM");
    }
  });
});
