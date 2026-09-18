import { type BoardSide, boardEndsOf } from "./board-ends";
import type { DominoRulesConfig } from "./config";
import type { PlayerId } from "./ids";
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
//
// ACÁ VIVEN LOS DOS LADOS DE LA MISMA PALABRA —lo que se PUEDE hacer y lo que se HIZO
// (§`MoveType`)— y por eso los tipos llevan adjetivo. Una sola palabra para dos cosas opuestas se
// leyó mal apenas existió el registro de la mano. El vocabulario sigue siendo UNO: el registro
// EXTRAE de esta unión, así que un verbo nuevo entra por un solo sitio.

export type AvailableActionType =
  | "PLAY_TILE"
  | "DRAW_TILE"
  | "PASS"
  | "REVEAL_TILES"
  | "ABANDON"
  | "PROPOSE_BET_MULTIPLIER"
  | "RESPOND_BET_MULTIPLIER";

// UNA JUGADA, que son TRES y no siete. En el dominó se pone ficha, se carga del pozo o se pasa:
// eso es todo lo que un jugador puede HACER sobre la mesa, y es exactamente lo que el v1 apunta en
// sus `historyMoves` (`rooms/schema/domino/*/round.state.ts`, con `isPassed`/`isLoaded`).
//
// LOS OTROS CUATRO VERBOS NO SON JUGADAS, y cada uno tiene su registro:
//
//   · `REVEAL_TILES` es la ceremonia de la ventana de reparto, no un movimiento en el tablero;
//   · `ABANDON` es una salida, y ya vive en `PlayerState.hasAbandoned` y en el evento `ABANDON`;
//   · los dos del AUMENTO son economía y no juego —el motor corre la negociación y nunca calcula
//     con lo acordado—. En v1 tampoco están en `historyMoves`: tienen su propio
//     `betMultiplierProposals`, que es el estado de trabajo de la negociación y la fuente de las
//     métricas. Acá ese estado ya es `RoundState.betOffer`, y las métricas leen el HISTORIAL DE
//     SOPORTE, que guarda el payload entero de los dos comandos. Meterlos en el registro de
//     jugadas sería una tercera copia, y arrastraría a cada jugada un `level` y un `accepted` que
//     para ella son siempre cero.
//
// Es un `Extract` y no una lista escrita de nuevo: el vocabulario tiene que seguir siendo UNO, así
// que un verbo renombrado arriba deja esto en `never` y el registro deja de compilar.
//
// Se declara acá y no junto a los comandos porque el ÁRBOL tiene que poder nombrarlo:
// `core/command.ts` importa `BoardSide` de `state/`, así que un `CommandName` adentro de un nodo
// del schema sería un ciclo. Que las tres sigan siendo verbos de verdad lo comprueba una aserción
// de tipo en aquel archivo.
export type MoveType = Extract<AvailableActionType, "PLAY_TILE" | "DRAW_TILE" | "PASS">;

// Una ficha jugable y por qué lados entra. `sides` nunca viene vacío: una ficha que no engancha
// por ningún lado no es una colocación, así que no está en la lista.
export interface TilePlacement {
  readonly tile: TileLike;
  readonly sides: readonly BoardSide[];
}

export interface AvailableAction {
  readonly action: AvailableActionType;
  // Solo en `PLAY_TILE`. En el resto no va.
  readonly placements?: readonly TilePlacement[];
  // Los niveles ofrecibles del catálogo, solo en `PROPOSE_BET_MULTIPLIER` y por la misma razón:
  // el nivel es parte de la elección, y cuál de ellos es legal depende de la mesa.
  readonly levels?: readonly number[];
}

export function availableActionsFor(
  playerId: PlayerId,
  match: MatchView,
  config: DominoRulesConfig,
): readonly AvailableAction[] {
  const actions: AvailableAction[] = [];
  const add = (action: AvailableActionType, extra: Omit<AvailableAction, "action"> = {}) =>
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
