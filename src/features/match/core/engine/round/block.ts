import type { PlayerId, TeamId } from "../../ids";
import { boardEndsOf } from "../../rules/board-ends";
import { hasPlayableTile } from "../../rules/playable";
import { handValue } from "../../rules/tiles";
import type { MatchState } from "../../state";
import { currentRoundOf, roundActivePlayers } from "../state-projections";

// TRANCA: nadie puede jugar ni siquiera con las fichas que quedan en el pozo. No alcanza
// con que el pozo tenga fichas: si ninguna conecta, la ronda ya está cerrada (§3.7).
// En 4P la rama no existe y el recorrido se limita naturalmente a las manos actuales.
//
// Esta mitad ya servía para las dos mesas y no se tocó: «nadie puede jugar» es la misma
// pregunta con dos jugadores que con cuatro.
export function isBlocked(match: MatchState): boolean {
  const round = currentRoundOf(match);
  const active = roundActivePlayers(match);
  // Una mano vacía cierra por DOMINÓ, no por tranca: no es este camino.
  if (active.some((player) => player.hand.tiles.length === 0)) return false;

  const ends = boardEndsOf(round.board);
  const someHandCanPlay = active.some((player) => hasPlayableTile([...player.hand.tiles], ends));
  const boneyardCanPlay = round.boneyard ? hasPlayableTile([...round.boneyard.tiles], ends) : false;
  return !someHandCanPlay && !boneyardCanPlay;
}

export interface BlockVerdict {
  readonly winnerId: PlayerId | undefined;
  readonly isTie: boolean;
  /** Suma de las manos del EQUIPO perdedor. Cero si hay empate: no se tarifa nada. */
  readonly points: number;
}

/**
 * Reglas §3.7: la tranca la gana el que tiene menos puntos en la mano y cobra los del otro.
 *
 * **SE CUENTA POR EQUIPO Y NO POR JUGADOR**, y el 2P es el caso de un equipo de un miembro —por
 * eso no hay una rama por cantidad de asientos—. Es la regla de v1 (`getBlockWinner`,
 * `domino-room-state.ts:514-534` del 4P): suma los pips de los DOS de cada pareja y gana la que
 * tenga menos. Contando por jugador, el mejor de la pareja perdedora le gana la tranca a una
 * pareja que en total tiene menos — y el marcador termina premiando al equipo equivocado.
 *
 * El empate lo declara y no lo resuelve: qué hacer con los puntos cuando dos manos empatan es
 * decisión de §3.7 del documento de reglas, y la ejecuta el Scorer.
 *
 * ⚠ **LA CARA DEL VEREDICTO ES DERIVADA, no elegida.** Lo que gana es un EQUIPO, pero
 * `RoundVerdict` viaja con un `winnerId` —lo consumen el marcador, el evento y el historial— así
 * que hay que nombrar a alguien. Se nombra al del equipo ganador con MENOS pips, desempatado por
 * asiento: en 2P es exactamente el de siempre, y en 4P es determinista, que es lo que el replay
 * necesita para reproducir.
 */
export function blockVerdictOf(match: MatchState): BlockVerdict {
  const active = roundActivePlayers(match);
  const totals = active.map((player) => ({
    playerId: player.playerId,
    teamId: player.teamId as TeamId,
    seatIndex: player.seatIndex,
    value: handValue([...player.hand.tiles]),
  }));

  const teamValue = (teamId: TeamId): number =>
    totals.filter((entry) => entry.teamId === teamId).reduce((sum, entry) => sum + entry.value, 0);

  const teams = [...new Set(totals.map((entry) => entry.teamId))];
  const lowest = Math.min(...teams.map(teamValue));
  const contenders = teams.filter((teamId) => teamValue(teamId) === lowest);
  if (contenders.length !== 1) return { winnerId: undefined, isTie: true, points: 0 };

  const winnerTeamId = contenders[0] as TeamId;
  const face = totals
    .filter((entry) => entry.teamId === winnerTeamId)
    .sort((a, b) => a.value - b.value || a.seatIndex - b.seatIndex)[0];
  if (!face) return { winnerId: undefined, isTie: true, points: 0 };

  const points = totals
    .filter((entry) => entry.teamId !== winnerTeamId)
    .reduce((sum, entry) => sum + entry.value, 0);
  return { winnerId: face.playerId, isTie: false, points };
}
