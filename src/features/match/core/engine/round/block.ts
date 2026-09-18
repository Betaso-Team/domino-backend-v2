import type { PlayerId } from "../../ids";
import { boardEndsOf } from "../../rules/board-ends";
import { hasPlayableTile } from "../../rules/playable";
import { handValue } from "../../rules/tiles";
import type { MatchState } from "../../state";
import { currentRoundOf, roundActivePlayers } from "../state-projections";

// TRANCA: nadie puede jugar ni siquiera con las fichas que quedan en el pozo. No alcanza
// con que el pozo tenga fichas: si ninguna conecta, la ronda ya está cerrada (§3.7).
// En 4P la rama no existe y el recorrido se limita naturalmente a las manos actuales.
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
  /** Suma de las manos PERDEDORAS. Cero si hay empate: no se tarifa nada. */
  readonly points: number;
}

// Reglas §3.7: gana quien tiene menos puntos en la mano, y cobra la suma de las
// manos ajenas. El empate lo declara y no lo resuelve: qué hacer con los puntos
// cuando dos manos empatan es decisión de §3.7 del documento de reglas, y la
// ejecuta el Scorer.
//
// Esta es la regla de 2P. En 4P la tranca compara el total del equipo, no el de
// cada jugador individual, y deberá entrar con sus propios tests.
export function blockVerdictOf(match: MatchState): BlockVerdict {
  const active = roundActivePlayers(match);
  const totals = active.map((player) => ({
    playerId: player.playerId,
    value: handValue([...player.hand.tiles]),
  }));

  const lowest = Math.min(...totals.map((entry) => entry.value));
  const contenders = totals.filter((entry) => entry.value === lowest);
  if (contenders.length !== 1) return { winnerId: undefined, isTie: true, points: 0 };

  const winnerId = (contenders[0] as { playerId: PlayerId }).playerId;
  const points = totals
    .filter((entry) => entry.playerId !== winnerId)
    .reduce((sum, entry) => sum + entry.value, 0);
  return { winnerId, isTie: false, points };
}
