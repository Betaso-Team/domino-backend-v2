import type { PlayerId, TeamId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import { RuleViolationError } from "../errors.js";
import {
  hasTeamAbandoned,
  isRoundActive,
  opponentTeam,
  playerOf,
  scoreboardOf,
} from "../state-projections.js";

export interface MatchOutcome {
  readonly winnerTeamId: TeamId;
  readonly reason: "SCORE" | "ABANDONMENT";
}

// JUEZ: read-only. Valida, deriva, dictamina. No muta nada.
export class MatchReferee {
  constructor(private readonly match: MatchState) {}

  // Va delante de TODA acción de jugador. Repetida y no envuelta en un genérico,
  // a propósito: así se ve de un vistazo cuáles la tienen, y es grepeable.
  assertIsPlaying(playerId: PlayerId): void {
    if (this.match.phase !== "PLAYING") {
      throw new RuleViolationError("MATCH_NOT_IN_PROGRESS");
    }
    if (!isRoundActive(playerOf(playerId, this.match))) {
      throw new RuleViolationError("NOT_PLAYING");
    }
  }

  assertCanAbandon(playerId: PlayerId): void {
    this.assertIsPlaying(playerId);
  }

  outcome(): MatchOutcome | undefined {
    // SI SE FUERON LOS DOS, NO GANÓ NADIE — y hay que decirlo ANTES que nada. Preguntando
    // por un equipo primero, el orden de evaluación coronaría al otro, y esa partida
    // —que nadie jugó— **pagaría premio**. En un juego con dinero eso no es un detalle
    // de estilo: es plata que sale por un `for` que no miró el caso.
    //
    // Era inalcanzable hasta la ventana de reparto (reglas §3.1): el primer forfeit
    // resolvía la partida y ya no quedaba a quién retirar. El vencimiento de la ventana
    // puede retirar a varios de una, así que ahora se alcanza. Truco lo descubrió al
    // implementar la ventana; acá nace cubierto.
    if (hasTeamAbandoned("A", this.match) && hasTeamAbandoned("B", this.match)) {
      return undefined;
    }

    for (const teamId of ["A", "B"] as const) {
      if (hasTeamAbandoned(teamId, this.match)) {
        return { winnerTeamId: opponentTeam(teamId), reason: "ABANDONMENT" };
      }
    }
    const { teamA, teamB } = scoreboardOf(this.match);
    const target = this.match.pointsToWin;
    if (teamA >= target) return { winnerTeamId: "A", reason: "SCORE" };
    if (teamB >= target) return { winnerTeamId: "B", reason: "SCORE" };
    return undefined;
  }
}
