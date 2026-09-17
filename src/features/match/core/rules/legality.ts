import type { PlayerId } from "../ids.js";
import { type BoardSide, boardEndsOf } from "./board-ends.js";
import type { BetLevel, DominoRulesConfig } from "./config.js";
import { hasPlayableTile, playableSides } from "./playable.js";
import {
  boneyardCountOf,
  currentRoundOf,
  currentTurnOf,
  handOf,
  isRoundActive,
  matchPhaseOf,
  playerOf,
  roundPhaseOf,
  tileInHand,
} from "./projections.js";
import { LEGAL, type Ruling, illegal } from "./ruling.js";
import type { TileLike } from "./tiles.js";
import type { MatchView, PublicMatchView, RoundView } from "./view.js";

// LA LEGALIDAD DEL DOMINÓ, COMPUESTA. Una función por VERBO, y el verbo es lo que el jugador
// intenta —no el aspecto que lo juzga—.
//
// Sale compuesta y no aspecto por aspecto porque **ninguna pregunta que alguien se hace de
// verdad es de un aspecto**: "¿puedo jugar esta ficha?" es a la vez la partida (¿sigo en
// juego?), la ronda (¿es mi turno?) y el tablero (¿engancha?). Partirla en tres obligaría a
// quien pregunta a saber cuáles son los tres y en qué orden — y el orden es lo único que decide
// QUÉ motivo se le muestra.
//
// Cada una devuelve un `Ruling` y **ninguna lanza**: las invariantes del motor no son de acá
// (ver la cabecera de `projections.ts`). Lo que del lado del servidor sería un `throw` acá es un
// motivo más, porque del lado del cliente la mesa legítimamente puede no tener ronda todavía.
//
// EL ORDEN DE LAS GUARDAS ES LA API. De lo más general a lo más específico: primero si estás en
// la partida, después si hay ronda, después si es tu turno, y solo al final si la ficha
// engancha. Al revés, al que ya perdió el turno le diríamos que su ficha no entra.

// ── las dos guardas que comparten todos los verbos ───────────────────────────────────────────

// ¿ESTE JUGADOR PUEDE ACTUAR? Va delante de TODO verbo. Es lo que `MatchReferee.assertIsPlaying`
// hacía —y sigue haciendo, leyendo esto—, y son dos hechos distintos con dos motivos distintos:
// la mesa no está en juego, o el que pregunta ya no está en ella.
export function canAct(playerId: PlayerId, match: PublicMatchView): Ruling {
  if (matchPhaseOf(match) !== "PLAYING") return illegal("MATCH_NOT_IN_PROGRESS");
  const player = playerOf(playerId, match);
  // Un id sin asiento contesta lo MISMO que uno que abandonó, y no hace falta distinguirlos:
  // ninguno de los dos está jugando esta mesa. Del lado del motor eso sí es una invariante
  // —`playerOf` revienta—, porque ahí el id viene de un asiento ya autenticado.
  if (!player || !isRoundActive(player)) return illegal("NOT_PLAYING");
  return LEGAL;
}

// ¿ES SU TURNO, con la ronda en juego? La fase se mira ACÁ y no en cada verbo porque
// `NEGOTIATING_BET` congela el turno sin tocarlo: `currentTurn` sigue siendo del mismo, así que
// sin este chequeo el que estaba jugando podría seguir jugando con la mesa congelada.
function isTurnOf(playerId: PlayerId, round: RoundView): Ruling {
  if (roundPhaseOf(round) !== "PLAYING") return illegal("NOT_PLAYING");
  if (currentTurnOf(round)?.playerId !== playerId) return illegal("NOT_YOUR_TURN");
  return LEGAL;
}

// ── los verbos del juego ─────────────────────────────────────────────────────────────────────

export function canPlayTile(
  playerId: PlayerId,
  tile: TileLike,
  side: BoardSide,
  match: MatchView,
): Ruling {
  const acting = canAct(playerId, match);
  if (!acting.legal) return acting;
  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");
  const turn = isTurnOf(playerId, round);
  if (!turn.legal) return turn;

  if (!tileInHand(playerId, tile, match)) return illegal("TILE_NOT_IN_HAND");
  // Se juzga la ficha que el cliente MANDÓ y no la que se encontró en la mano, y da lo mismo:
  // `sameTile` compara sin orden y `playableSides` también, así que `[3|5]` y `[5|3]` enganchan
  // en los mismos lados.
  if (!playableSides(tile, boardEndsOf(round.board)).includes(side)) {
    return illegal("SIDE_NOT_PLAYABLE");
  }
  return LEGAL;
}

export function canDrawTile(playerId: PlayerId, match: MatchView): Ruling {
  const turn = actingTurn(playerId, match);
  if (!turn.legal) return turn;
  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");

  // ROBAR ES OBLIGATORIO SOLO CUANDO NO SE PUEDE JUGAR (reglas §3.6): con una ficha que
  // engancha, robar sería elegir no jugar, que en dominó no existe.
  if (hasPlayable(playerId, match)) return illegal("MUST_PLAY_INSTEAD_OF_DRAWING");
  if (boneyardCountOf(round) === 0) return illegal("BONEYARD_EMPTY");
  return LEGAL;
}

export function canPass(playerId: PlayerId, match: MatchView): Ruling {
  const turn = actingTurn(playerId, match);
  if (!turn.legal) return turn;
  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");

  if (hasPlayable(playerId, match)) return illegal("MUST_PLAY_INSTEAD_OF_DRAWING");
  // Pasar es el ÚLTIMO recurso: mientras quede pozo hay que robar (reglas §3.6). Los dos
  // motivos son distintos a propósito —"jugá" y "robá" son dos instrucciones diferentes— y es
  // lo que le deja al cliente pintar el botón correcto en vez de un "no se puede".
  if (boneyardCountOf(round) > 0) return illegal("MUST_DRAW_INSTEAD_OF_PASSING");
  return LEGAL;
}

// LEVANTAR LAS FICHAS de la ventana de reparto (reglas §3.1). NO pasa por `isTurnOf`: la ventana
// controla a TODOS a la vez, así que no hay turno que mirar — y de hecho la fase es `DEALING`,
// donde `isTurnOf` diría `NOT_PLAYING`.
export function canRevealTiles(playerId: PlayerId, match: PublicMatchView): Ruling {
  const acting = canAct(playerId, match);
  if (!acting.legal) return acting;
  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");

  if (roundPhaseOf(round) !== "DEALING") return illegal("NOT_DEALING");
  if (playerOf(playerId, match)?.hasSeenTiles) return illegal("TILES_ALREADY_SEEN");
  return LEGAL;
}

// Abandonar no tiene condición propia: alcanza con estar jugando. Existe como función igual
// —en vez de que quien pregunte llame a `canAct`— porque es un VERBO, y `actions.ts` recorre
// verbos. Que su cuerpo sea una delegación es la respuesta honesta, no una capa de más.
export const canAbandon = (playerId: PlayerId, match: PublicMatchView): Ruling =>
  canAct(playerId, match);

// ── el aumento de apuesta ────────────────────────────────────────────────────────────────────

// Cuántas fichas puede haber en el tablero y todavía dejar proponer. UNA, no cero: el v1 deja
// proponer al que abrió la ronda y al que todavía no jugó. Dos ya es la mano en curso.
const MAX_TILES_FOR_BET_WINDOW = 1;

export const betLevelOf = (level: number, config: DominoRulesConfig): BetLevel | undefined =>
  config.betLevels.find((option) => option.level === level);

// PROPONER UN AUMENTO. Los límites son los de v1 y NO son adorno de producto — cada uno tapa
// una forma concreta de sacar ventaja con dinero real:
//
//   · mesa gratis            no hay qué aumentar, y cobrarlo sería cobrar una entrada que
//                            nadie pagó
//   · catálogo cargado       lista vacía = la mesa no ofrece aumentar. Es el reposo, porque
//                            el catálogo viene de otro repo y su falta falla CERRADO
//   · uno aceptado           el tope del v1. Sin él la mesa se sube sin techo a fuerza de
//                            insistir ronda a ronda
//   · uno pendiente          sin esto, dos propuestas cruzadas dejan dos ofertas vivas y la
//                            respuesta no sabe a cuál contesta
//   · ventana de ≤1 ficha    proponer con la mano medio jugada es proponer sabiendo cómo
//                            viene la ronda. El aumento se ofrece cuando los dos saben lo
//                            mismo, que es al principio
//   · nivel del catálogo     el cliente manda un NIVEL, no un importe: los números los pone
//                            el servidor
//
// NO MIRA EL TURNO, y es de v1: cualquiera de los dos puede proponer le toque o no.
export function canProposeBet(
  playerId: PlayerId,
  level: number,
  match: PublicMatchView,
  config: DominoRulesConfig,
): Ruling {
  const acting = canAct(playerId, match);
  if (!acting.legal) return acting;
  if (config.isFreeRoom) return illegal("BETTING_DISABLED");
  if (config.betLevels.length === 0) return illegal("BETTING_DISABLED");
  if (match.acceptedBetLevel > 0) return illegal("BET_ALREADY_ACCEPTED");

  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");
  if (round.betOffer) return illegal("BET_ALREADY_PENDING");
  // La ventana es de la fase de juego: en el reparto todavía no se ve nada y en la presentación
  // la ronda ya se resolvió. `NEGOTIATING_BET` lo tapa `betOffer`, arriba.
  if (roundPhaseOf(round) !== "PLAYING") return illegal("BET_WINDOW_CLOSED");
  if (round.board.tiles.length > MAX_TILES_FOR_BET_WINDOW) return illegal("BET_WINDOW_CLOSED");

  if (!betLevelOf(level, config)) return illegal("UNKNOWN_BET_LEVEL");
  return LEGAL;
}

// CONTESTAR es SIEMPRE legal para el que no propuso, mientras la oferta siga viva: no se mira la
// fase —la fase ES la negociación— ni el turno. Decir que no a que te cobren de más no puede
// depender de a quién le toca jugar.
export function canRespondBet(playerId: PlayerId, match: PublicMatchView): Ruling {
  const acting = canAct(playerId, match);
  if (!acting.legal) return acting;
  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");

  if (!round.betOffer) return illegal("NO_BET_PENDING");
  if (round.betOffer.proposerId === playerId) return illegal("NOT_YOUR_BET");
  return LEGAL;
}

// ── consultas que las reglas necesitan y el afuera también ───────────────────────────────────

// ¿LE ENGANCHA ALGUNA? Es la pregunta detrás de las tres reglas de §3.6 (jugar, robar, pasar) y
// la contesta la MANO, así que pide la vista completa. Con una mano que no se ve —el asiento
// ajeno en el cliente— contesta `false`: no se puede afirmar que alguien PUEDE jugar sin verle
// las fichas, y errar hacia "no puede" apaga un botón que no era suyo.
export function hasPlayable(playerId: PlayerId, match: MatchView): boolean {
  const round = currentRoundOf(match);
  const tiles = handOf(playerId, match);
  if (!round || !tiles) return false;
  return hasPlayableTile(tiles, boardEndsOf(round.board));
}

// Los que todavía no levantaron sus fichas, para la ventana de reparto. Es del juez de la ronda
// —el conductor le pregunta si ya puede arrancar— y vive acá porque es una lectura pura.
export const playersWithoutTilesSeen = (match: PublicMatchView): readonly PlayerId[] =>
  match.players
    .filter((player) => isRoundActive(player) && !player.hasSeenTiles)
    .map((player) => player.playerId);

// ── privadas ─────────────────────────────────────────────────────────────────────────────────

// Las dos guardas que los tres verbos de turno comparten, en el orden que comparten.
function actingTurn(playerId: PlayerId, match: PublicMatchView): Ruling {
  const acting = canAct(playerId, match);
  if (!acting.legal) return acting;
  const round = currentRoundOf(match);
  if (!round) return illegal("NO_ROUND_IN_PROGRESS");
  return isTurnOf(playerId, round);
}
