import type { PlayerId, TeamId } from "../../ids";
import { canAct } from "../../rules/legality";
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
