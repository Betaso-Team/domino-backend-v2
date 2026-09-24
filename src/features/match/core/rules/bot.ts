import { type AvailableAction, type MoveType, availableActionsFor } from "./actions";
import type { BoardSide } from "./board-ends";
import type { DominoRulesConfig } from "./config";
import type { PlayerId } from "./ids";
import { matchPhaseOf, playerOf } from "./projections";
import { type TileLike, tileValue } from "./tiles";
import type { MatchView } from "./view";

// QUÉ JUEGA LA MÁQUINA. Es la política del bot que reemplaza al que se retira de una mesa de
// cuatro, portada de v1 (`DominoUtils.chooseTile`, `shared/utils/domino.utils.ts:74-101`).
//
// **NO DECIDE LEGALIDAD, ELIGE ENTRE LO LEGAL.** Todo lo que puede jugar sale de
// `availableActionsFor`, que es la misma consulta que arma la barra de botones del front. Es la
// decisión de diseño entera de este archivo, y el motivo es concreto: un bot que eligiera con su
// propia idea de "esto engancha" puede mandar una jugada que el comando rechaza, y ahí el asiento
// queda mudo hasta que vence el reloj — o sea que el compañero al que el bot vino a salvar pierde
// igual, y por un camino que ningún test de reglas ve.
//
// Y por eso vive en `rules/` y no en el motor: no muta nada, no conoce Colyseus y contesta con el
// mismo vocabulario con el que el cliente pinta la mesa. El día que el front quiera mostrar una
// sugerencia —«jugá ésta»— es esta misma función.

export type BotMove =
  | {
      readonly type: Extract<MoveType, "PLAY_TILE">;
      readonly tile: TileLike;
      readonly side: BoardSide;
    }
  | { readonly type: Extract<MoveType, "DRAW_TILE" | "PASS"> };

/**
 * La jugada que le toca a este asiento, o `undefined` si no hay ninguna que hacer —no es su
 * turno, la mesa está en la ventana de reparto, la ronda está congelada por un aumento—.
 *
 * **LA POLÍTICA ES LA DE v1: la ficha jugable de MAYOR valor.** Es deliberadamente boba y no es
 * un descuido: el bot existe para que la mesa no muera, no para jugar bien. Una política fuerte
 * es peor producto —el que perdió a su compañero termina con un socio mejor que el que se fue— y
 * es además el camino a que alguien se retire A PROPÓSITO.
 *
 * ⚠ **EL TABLERO VACÍO NO ES UN CASO APARTE**, aunque en v1 lo sea (`playBotTile` lo trata con su
 * propia rama, `getHighestValueTile`). Acá sale solo: con la mesa vacía toda la mano es jugable
 * —`playableSides` normaliza a un lado único— así que "la jugable de mayor valor" ya ES "la más
 * alta de la mano". Una rama para eso sería la misma regla escrita dos veces.
 *
 * **EL ORDEN DE PREFERENCIA ES PONER, CARGAR, PASAR**, y no se elige: es el que las reglas
 * imponen. Con una ficha jugable, robar y pasar son ilegales (`MUST_PLAY_INSTEAD_OF_DRAWING`), y
 * con pozo cargado pasar tampoco se puede. O sea que a lo sumo una de las tres está disponible en
 * el mismo turno, y este orden es el que lo dice en voz alta.
 */
export function botMoveOf(
  playerId: PlayerId,
  match: MatchView,
  config: DominoRulesConfig,
): BotMove | undefined {
  const actions = availableActionsFor(playerId, match, config);

  const best = bestPlacementOf(actions);
  if (best) return { type: "PLAY_TILE", ...best };
  if (actions.some((action) => action.action === "DRAW_TILE")) return { type: "DRAW_TILE" };
  if (actions.some((action) => action.action === "PASS")) return { type: "PASS" };
  return undefined;
}

/**
 * La colocación de más pips, con los dos desempates escritos.
 *
 * **EMPATE DE VALOR → LA PRIMERA DE LA MANO.** Es el `reduce` con `>` estricto de v1, y lo que lo
 * hace aceptable acá es que el orden de la mano no es arbitrario: sale del reparto, que se deriva
 * del seed. Un desempate por azar dejaría al replay sin poder reproducir la partida.
 *
 * **ENGANCHA POR LOS DOS LADOS → EL PRIMERO QUE DECLARA la regla**, que es `LEFT`. Misma razón, y
 * coincide con v1, que apila el lado izquierdo primero.
 */
function bestPlacementOf(
  actions: readonly AvailableAction[],
): { tile: TileLike; side: BoardSide } | undefined {
  const placements = actions.find((action) => action.action === "PLAY_TILE")?.placements ?? [];

  let best: { tile: TileLike; side: BoardSide } | undefined;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const placement of placements) {
    const value = tileValue(placement.tile);
    const side = placement.sides[0];
    if (side === undefined || value <= bestValue) continue;
    best = { tile: placement.tile, side };
    bestValue = value;
  }
  return best;
}

/**
 * ¿ESTE ASIENTO LO PUEDE SEGUIR JUGANDO UNA MÁQUINA? Se pregunta cuando alguien se retira —por el
 * verbo o porque se le venció el reloj— y la respuesta decide entre dos finales muy distintos:
 * la mesa sigue con un bot en ese lugar, o la partida se cierra ahí.
 *
 * Son las guardas de v1 (`on-leave.ts:58-72`), traducidas a lo que este motor sí tiene:
 *
 *   · **LA MESA LO OFRECE** (`enableBots`, del catálogo).
 *   · **LA PARTIDA ESTÁ EN JUEGO.** v1 lo pregunta como «era válida antes de este abandono»
 *     (`isGameValid`: todos los reales participaron). Acá eso ES la fase: durante la ventana de
 *     reparto nadie participó todavía, y ahí sentar un bot sostendría una partida que nunca
 *     arrancó — convirtiendo en cobro lo que tiene que ser un reembolso. Con plata de por medio,
 *     ésa es la mitad que no se puede equivocar.
 *   · **QUEDA ALGUIEN MÁS EN SU EQUIPO**, de carne y hueso y sin retirarse. Es el `checkPlayersLeft`
 *     de v1, y es lo único que el bot existe para proteger: al compañero que no hizo nada y se
 *     quedaría jugando uno contra dos. Sin nadie a quien proteger no hay bot que poner.
 *
 * ⚠ **LA TERCERA GUARDA ES LA QUE APAGA EL 2P**, y por eso no hay un chequeo del tamaño de la
 * mesa. Con un jugador por bando, el equipo del que se va queda vacío por construcción y la
 * respuesta es siempre `false` — que es exactamente lo que v1 declara aparte, prohibiendo
 * `enableBots` en los modos de dos (`game-mode.dto.ts:28-36`). Una regla en vez de dos que se
 * pueden contradecir.
 */
export function canSeatBot(playerId: PlayerId, match: MatchView, config: BotConfig): boolean {
  if (!config.enableBots) return false;
  if (matchPhaseOf(match) !== "PLAYING") return false;

  const leaving = playerOf(playerId, match);
  if (!leaving || leaving.isBot) return false;

  return match.players.some(
    (other) =>
      other.playerId !== playerId &&
      other.teamId === leaving.teamId &&
      !other.isBot &&
      !other.hasAbandoned,
  );
}

/** Lo único que la guarda necesita de la mesa. `DominoRulesConfig` lo satisface. */
export interface BotConfig {
  readonly enableBots: boolean;
}
