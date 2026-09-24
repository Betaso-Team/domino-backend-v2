import type { PlayerId } from "./ids";

import type { MatchPhase, RoundPhase } from "./phases";
import { type TileLike, sameTile } from "./tiles";
import type { MatchView, PlayerView, PublicMatchView, RoundView, TurnView } from "./view";

// LAS LECTURAS DE LA VISTA, y son TOTALES: ninguna lanza.
//
// Es la diferencia que importa contra `engine/state-projections.ts`, que hace las mismas
// preguntas y revienta la invariante cuando la respuesta no existe. Las dos están bien, y por
// motivos opuestos:
//
//   · el MOTOR pregunta desde un comando, o sea con la partida en juego. "No hay ronda" ahí es
//     un bug, y devolver `undefined` lo taparía obligando a cada mutador a mirarlo.
//   · una REGLA se pregunta lo mismo desde el cliente, con la mesa recién abierta o ya
//     terminada. Ahí "todavía no" es la respuesta correcta, y lanzar sería pedirle al que
//     pinta un botón que envuelva todo en un `try`.
//
// Y son las DOS caras del narrowing: el árbol declara los ejes como `string` (nota compartida en
// `state/tile.ts`), así que el cast vive acá, en un solo archivo, y de este lado todo compara
// contra uniones cerradas.

export const playerOf = (playerId: PlayerId, match: PublicMatchView): PlayerView | undefined =>
  match.players.find((candidate) => candidate.playerId === playerId);

export const currentRoundOf = (match: PublicMatchView): RoundView | undefined => match.currentRound;

export const currentTurnOf = (round: RoundView): TurnView | undefined => round.currentTurn;

// AUSENTE Y AGOTADO DAN 0, que es lo correcto para toda regla que quiera saber "¿queda de dónde
// robar?" — la tranca, el veto de pasar. Distinguir "este modo no tiene pozo" (4P) de "el pozo
// se agotó" es una pregunta del conductor, no de la legalidad.
export const boneyardCountOf = (round: RoundView): number => round.boneyard?.count ?? 0;

export const roundPhaseOf = (round: RoundView): RoundPhase => round.phase as RoundPhase;

export const matchPhaseOf = (match: PublicMatchView): MatchPhase => match.phase as MatchPhase;

// LA MANO, atravesando la puerta. `undefined` es "no la ves" y nunca "está vacía" — el que
// pregunta por un asiento ajeno recibe lo mismo que el que pregunta por uno que no existe, y no
// hace falta distinguirlos: ninguna de las dos respuestas es una mano.
export const handOf = (
  playerId: PlayerId,
  match: MatchView,
): ReadonlyArray<TileLike> | undefined => {
  const priv = match.privateOf(playerId);
  return priv ? [...priv.tiles] : undefined;
};

// ¿Tiene ESTA ficha? Devuelve la que tiene —y no un booleano— porque el que pregunta la necesita
// después: `sameTile` compara sin orden, así que la que el cliente mandó puede venir dada vuelta
// respecto de la que está en la mano.
export const tileInHand = (
  playerId: PlayerId,
  tile: TileLike,
  match: MatchView,
): TileLike | undefined => handOf(playerId, match)?.find((held) => sameTile(held, tile));

// Sigue en la ronda el que no la abandonó. Es estructural, no una regla del dominó.
export const isRoundActive = (player: PlayerView): boolean => !player.hasAbandoned;
