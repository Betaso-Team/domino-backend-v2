import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settlementOf } from "../network/settlement";
import {
  type SeatedMatch,
  bootServer,
  historyOf,
  playUntilDecided,
  revealHands,
  seatFour,
  waitUntil,
} from "./e2e-harness";

// LA PARTIDA DE CUATRO, DE PUNTA A PUNTA Y HASTA `SCORE`. Es la contraparte de `game-2p` y lo que
// cierra la mesa de cuatro: todo lo demás mide una pieza —la tranca por equipo, el reparto, el
// bot— y esto mide que las piezas juntas terminan una partida.
//
// ⚠ LO QUE SÓLO SE PUEDE MEDIR ACÁ son las dos reglas que en 2P son indistinguibles de otra cosa:
// que los puntos se acrediten AL EQUIPO —los dos compañeros comparten marcador— y que el premio
// salga para los DOS ganadores. Con dos jugadores, «el equipo» y «el jugador» dan el mismo número
// y ninguna aserción los separa.

const SEATS = ["q1", "q2", "q3", "q4"] as const;

let server: ColyseusTestServer;
let match: SeatedMatch;

// La partida se juega UNA vez, en el hook, por lo mismo que en `game-2p`: jugarla dentro del
// primer `it` ata los demás a su orden, y `vitest -t` sobre cualquier otro correría sobre una
// mesa sin empezar.
beforeAll(async () => {
  server = await bootServer(2_602);
  match = await seatFour(server, SEATS, "seed-cuatro-completa");
  await revealHands(match);

  await playUntilDecided(match);
  await waitUntil(() => match.serverState.phase === "FINISHED", 5_000);
}, 60_000);

afterAll(async () => {
  await server.shutdown();
});

describe("partida 4P completa", () => {
  it("terminó por puntos y no por abandono", async () => {
    const state = match.serverState;

    expect(state.phase).toBe("FINISHED");
    expect(state.players.length).toBe(4);
    // NADIE SE RETIRÓ Y NINGÚN ASIENTO ES MÁQUINA: los cuatro jugaron hasta el final. Es la
    // diferencia entre una partida ganada y una abandonada, y es lo que hace que el `SCORE` de
    // más abajo signifique algo.
    expect(state.players.some((player) => player.hasAbandoned)).toBe(false);
    expect(state.players.some((player) => player.isBot)).toBe(false);

    const { teamA = 0, teamB = 0 } = state.scoreboard ?? {};
    expect(Math.max(teamA, teamB)).toBeGreaterThanOrEqual(state.pointsToWin);
    expect(state.pastRounds.length).toBeGreaterThan(0);
  });

  // ⚠ LOS PUNTOS SON DEL EQUIPO, y en 2P esto no se puede afirmar: allá cada equipo tiene un
  // miembro, así que «el marcador del equipo» y «el del jugador» son el mismo número. Acá el
  // marcador tiene dos entradas para cuatro personas, y cada ronda la gana una PAREJA.
  it("cada ronda la ganó una pareja, y el marcador tiene dos entradas para cuatro", async () => {
    const state = match.serverState;
    const rounds = [...state.pastRounds];

    expect(rounds.length).toBeGreaterThan(0);
    for (const round of rounds) {
      // Una ronda sin ganador es un empate de tranca, que es legítimo y no suma a nadie.
      if (!round.winnerTeamId) {
        expect(round.points).toBe(0);
        continue;
      }
      expect(["A", "B"]).toContain(round.winnerTeamId);
      // La CARA del veredicto es de la pareja que ganó, no de cualquiera.
      const face = state.players.find((player) => player.playerId === round.winnerId);
      expect(face?.teamId).toBe(round.winnerTeamId);
    }

    // ⚠ ACÁ NO SE VUELVE A SUMAR `round.points` PARA COMPARARLO CON EL MARCADOR, y la omisión
    // es deliberada: esa aserción es TAUTOLÓGICA. Los dos lados salen del MISMO `RoundVerdict`
    // —el marcador lo escribió el `Scorer` con esos puntos y ese equipo—, así que cualquier
    // regla de conteo, correcta o no, hace que la suma cuadre. Medido: mutar el dominó para que
    // vuelva a cobrar la mano del compañero deja este archivo entero en verde.
    //
    // Dónde SÍ se mide esa regla: `engine/tests/round-flow.int.test.ts` («el dominó cobra los
    // pips del equipo rival»), que con esa misma mutación se pone rojo. Lo que este `it` puede
    // afirmar de verdad es lo de arriba —que la cara del veredicto pertenece al equipo que
    // ganó la ronda—, que es la alineación entre las dos mitades del veredicto.

    // Y el marcador es de EQUIPOS y no de jugadores: dos entradas para cuatro personas. Es
    // estructural (`PlayerState` no lleva `score`) y acá queda afirmado sobre una partida real.
    expect(Object.keys(state.scoreboard?.toJSON() ?? {}).sort()).toEqual(["teamA", "teamB"]);
  });

  // ⚠ EL PREMIO DE LA PAREJA, y es lo que el incremento abrió. Hasta acá `settlementOf` exigía
  // EXACTAMENTE un ganador, así que el final de una mesa de cuatro lanzaba DESPUÉS del veredicto:
  // sin premio y sin reembolso, plata trabada. Se proyecta sobre la partida REAL que se acaba de
  // jugar —no sobre un estado armado a mano— que es la única forma de saber que el veredicto del
  // motor y el reparto hablan de la misma mesa.
  it("liquida el premio a los DOS ganadores, entero a cada uno", async () => {
    const state = match.serverState;
    const winnerTeamId = (state.scoreboard?.teamA ?? 0) >= state.pointsToWin ? "A" : "B";

    const instruction = settlementOf(
      { type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" },
      state,
      match.config,
    );

    expect(instruction?.kind).toBe("REWARD");
    expect(instruction?.matchId).toBe(match.config.matchId);
    expect(instruction?.entries).toHaveLength(2);
    // ENTERO A CADA UNO Y NO LA MITAD: el `prize` del catálogo es el premio POR CABEZA, que es la
    // regla de v1. Dividirlo entre los cobradores le pagaría de menos a los dos.
    for (const entry of instruction?.entries ?? []) {
      expect(entry.amount).toBe(match.config.prize);
    }
    // Y les paga a los dos del equipo que ganó, por su identidad externa y no por el asiento.
    const winners = state.players
      .filter((player) => player.teamId === winnerTeamId)
      .map((player) => player.userId)
      .sort();
    expect(instruction?.entries.map((entry) => entry.userId).sort()).toEqual(winners);
    // Las claves de idempotencia son distintas entre sí: con una sola, el segundo cobro se
    // descartaría por duplicado y uno de los dos socios no cobraría nunca.
    const keys = new Set((instruction?.entries ?? []).map((entry) => entry.idempotencyKey));
    expect(keys.size).toBe(2);
  });

  it("el historial cierra con el veredicto y sin huecos de seq", async () => {
    const entries = await historyOf(match.config.matchId);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    // Los mismos tres del final que en la mesa de dos: el veredicto abre la presentación, al
    // vencer ésa se abre la ventana de revancha, y al vencer la ventana se apaga la mesa.
    expect(entries.slice(-3).map((entry) => entry.type)).toEqual([
      "MATCH_RESOLVED",
      "DEADLINE_EXPIRED",
      "DEADLINE_EXPIRED",
    ]);
    // ⚠ Y NINGUNA JUGADA ES DEL SISTEMA: en una partida sana de cuatro no se sienta ninguna
    // máquina, así que todo lo que sea un verbo tiene que venir de una persona. Es la aserción
    // que se pondría roja el día que un bot se cuele en una mesa donde nadie se fue.
    for (const entry of entries) {
      if (entry.kind === "COMMAND") expect(entry.source).toBe("PLAYER");
    }
    expect(entries.some((entry) => entry.type === "BOT_SEATED")).toBe(false);
  });
});
