import type { PlayerId, TeamId } from "../../ids";
import { canAct, wasAbortedAtDeal } from "../../rules/legality";
import type { MatchView } from "../../rules/view";
import type { MatchState } from "../../state";
import { SchemaMatchView } from "../../state/view";
import { assertLegal } from "../errors";
import { hasTeamAbandoned, opponentTeam, scoreboardOf } from "../state-projections";

export interface MatchOutcome {
  readonly winnerTeamId: TeamId;
  readonly reason: "SCORE" | "ABANDONMENT";
}

// JUEZ: read-only. Valida, deriva, dictamina. No muta nada.
//
// Se quedó con el VEREDICTO DE LA PARTIDA (`outcome`), que es lo único de acá que no es una
// legalidad: no contesta "¿se puede?" sino "¿ya terminó, y quién ganó?". Eso no es una consulta
// que el cliente pueda hacer —depende del marcador y de los abandonos, que son del servidor— así
// que no se fue a `rules/`.
export class MatchReferee {
  private readonly view: MatchView;

  constructor(private readonly match: MatchState) {
    this.view = new SchemaMatchView(match);
  }

  // Va delante de TODA acción de jugador, y desde que la legalidad se compone en `rules/` ya va
  // ADENTRO de cada verbo. Sigue expuesta porque los dos comandos del aumento de apuesta la
  // llaman sueltos —su juez no es éste— y porque es grepeable.
  assertIsPlaying(playerId: PlayerId): void {
    assertLegal(canAct(playerId, this.view));
  }

  assertCanAbandon(playerId: PlayerId): void {
    this.assertIsPlaying(playerId);
  }

  outcome(): MatchOutcome | undefined {
    // ANULADA EN EL REPARTO: no gana nadie, quede quien quede. Va ANTES que cualquier forfeit,
    // porque es lo que la sala pregunta al cerrarse para decidir si reembolsa — contestar «ganó
    // el rival» dejaría la mesa sin premio (nunca pasó por `MATCH_RESOLVED`) y sin reembolso.
    if (wasAbortedAtDeal(this.match)) return undefined;

    // LA META ALCANZADA LE GANA A CUALQUIER FORFEIT, y va antes que los abandonos. Los puntos de
    // la mano decisiva se acreditan al CERRARLA, pero el veredicto sale recién al vencer su pausa,
    // y en esa pausa `ABANDON` sigue siendo legal: preguntando primero por el retiro, el que
    // acababa de ganar y apretaba «salir» le regalaba la partida —y el premio— al rival. La meta
    // sólo se alcanza al cerrar una mano, así que acá no hay forfeit que pueda haber llegado antes.
    const { teamA, teamB } = scoreboardOf(this.match);
    const target = this.match.pointsToWin;
    if (teamA >= target) return { winnerTeamId: "A", reason: "SCORE" };
    if (teamB >= target) return { winnerTeamId: "B", reason: "SCORE" };

    // SI SE FUERON LOS DOS, NO GANÓ NADIE — y hay que decirlo ANTES que el forfeit. Preguntando
    // por un equipo primero, el orden de evaluación coronaría al otro, y esa partida
    // —que nadie jugó— **pagaría premio**. En un juego con dinero eso no es un detalle
    // de estilo: es plata que sale por un `for` que no miró el caso.
    //
    // El único camino que retira a varios de una —el vencimiento de la ventana de reparto— ya
    // contestó arriba (`wasAbortedAtDeal`), así que hoy es una red: el primer forfeit resuelve la
    // partida y ya no queda a quién retirar. Se queda porque es la pregunta que sale plata si
    // alguna vez aparece otro camino.
    if (hasTeamAbandoned("A", this.match) && hasTeamAbandoned("B", this.match)) {
      return undefined;
    }

    for (const teamId of ["A", "B"] as const) {
      if (hasTeamAbandoned(teamId, this.match)) {
        return { winnerTeamId: opponentTeam(teamId), reason: "ABANDONMENT" };
      }
    }
    return undefined;
  }
}
