import type { PlayerId } from "../ids";
import { type BoardSide, boardEndsOf } from "./board-ends";
import type { DominoRulesConfig } from "./config";
import {
  canAbandon,
  canDrawTile,
  canPass,
  canPlayTile,
  canProposeBet,
  canRespondBet,
  canRevealTiles,
} from "./legality";
import { playableSides } from "./playable";
import { currentRoundOf, handOf } from "./projections";
import type { TileLike } from "./tiles";
import type { MatchView } from "./view";

// QUÉ PUEDE HACER ESTE JUGADOR AHORA MISMO. Es la consulta que arma la barra de botones, y no
// agrega ni una regla: recorre los verbos preguntándole a la legalidad compuesta por cada uno.
//
// Que exista es consecuencia de que la legalidad devuelva un VEREDICTO en vez de lanzar. Con
// excepciones esto sería un barrido de `try/catch`; acá es un `filter`.
//
// Y LAS COLOCACIONES VIAJAN CON EL VERBO, porque en el dominó las fichas SON los botones: una
// lista plana de verbos describiría de menos justo donde más importa —"podés jugar" no dice
// cuál ni de qué lado—, y derivarlo afuera obligaría al cliente a reimplementar `playableSides`.

export type GameAction =
  | "PLAY_TILE"
  | "DRAW_TILE"
  | "PASS"
  | "REVEAL_TILES"
  | "ABANDON"
  | "PROPOSE_BET_MULTIPLIER"
  | "RESPOND_BET_MULTIPLIER";

// Una ficha jugable y por qué lados entra. `sides` nunca viene vacío: una ficha que no engancha
// por ningún lado no es una colocación, así que no está en la lista.
export interface TilePlacement {
  readonly tile: TileLike;
  readonly sides: readonly BoardSide[];
}

export interface LegalAction {
  readonly action: GameAction;
  // Solo en `PLAY_TILE`. En el resto no va.
  readonly placements?: readonly TilePlacement[];
  // Los niveles ofrecibles del catálogo, solo en `PROPOSE_BET_MULTIPLIER` y por la misma razón:
  // el nivel es parte de la elección, y cuál de ellos es legal depende de la mesa.
  readonly levels?: readonly number[];
}

export function legalActionsFor(
  playerId: PlayerId,
  match: MatchView,
  config: DominoRulesConfig,
): readonly LegalAction[] {
  const actions: LegalAction[] = [];
  const add = (action: GameAction, extra: Omit<LegalAction, "action"> = {}) =>
    actions.push({ action, ...extra });

  const placements = placementsFor(playerId, match);
  if (placements.length > 0) add("PLAY_TILE", { placements });
  if (canDrawTile(playerId, match).legal) add("DRAW_TILE");
  if (canPass(playerId, match).legal) add("PASS");
  if (canRevealTiles(playerId, match).legal) add("REVEAL_TILES");
  if (canAbandon(playerId, match).legal) add("ABANDON");

  // Se prueba NIVEL POR NIVEL y no una vez: los motivos por los que un nivel concreto no se
  // puede ofrecer (`UNKNOWN_BET_LEVEL`) y los que cierran la ventana entera son distintos, y
  // filtrar es lo que deja al cliente pintar tres niveles cuando dos son ofrecibles.
  const levels = config.betLevels
    .map(({ level }) => level)
    .filter((level) => canProposeBet(playerId, level, match, config).legal);
  if (levels.length > 0) add("PROPOSE_BET_MULTIPLIER", { levels });

  if (canRespondBet(playerId, match).legal) add("RESPOND_BET_MULTIPLIER");

  return actions;
}

// ── privadas ─────────────────────────────────────────────────────────────────────────────────

// LAS COLOCACIONES LEGALES, y se preguntan a `canPlayTile` ficha por ficha y lado por lado —no a
// `playableSides` directamente—. Es más caro (14 llamadas en el peor caso) y es lo correcto: si
// mañana una regla nueva veta una jugada que el tablero sí acepta, `playableSides` seguiría
// diciendo que sí y el botón quedaría encendido. La única fuente de "se puede" es la legalidad.
//
// Con una mano que no se ve —el asiento ajeno en el cliente— devuelve vacío, por lo mismo que
// `hasPlayable`: no se afirma que alguien puede jugar sin verle las fichas.
function placementsFor(playerId: PlayerId, match: MatchView): readonly TilePlacement[] {
  const round = currentRoundOf(match);
  const tiles = handOf(playerId, match);
  if (!round || !tiles) return [];

  const ends = boardEndsOf(round.board);
  const placements: TilePlacement[] = [];
  for (const tile of tiles) {
    const sides = playableSides(tile, ends).filter(
      (side) => canPlayTile(playerId, tile, side, match).legal,
    );
    if (sides.length > 0) placements.push({ tile, sides });
  }
  return placements;
}

// NO HAY `stakes.ts`, y la ausencia es la diferencia con truco. Allá el tarifado es una TABLA
// —cada escalón de canto vale N piedras— y tenerla escrita dos veces es exactamente cómo los dos
// lados se desincronizan, así que vive en las reglas. En el dominó los puntos de una ronda son
// los pips que le quedan al que perdió: no hay tabla que compartir, hay una suma, y ya vive acá
// (`tiles.ts#handValue`). Lo económico —`acceptedBetExtra`, `acceptedBetLevel`— está en el árbol
// y el motor NO calcula con él; quien lo lee es la liquidación, al cerrar.
