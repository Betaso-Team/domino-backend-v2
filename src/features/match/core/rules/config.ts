/**
 * UN NIVEL DEL CATÁLOGO DE AUMENTO, con los tres números de v1 (`BetIncreaseOption`):
 * `extra` es lo que se SUMA al multiplicador del modo —o sea, lo que termina en los puntos
 * de ranking— y los otros dos son lo que le cambia el dinero a la mesa si se acepta.
 *
 * `level` es la identidad que el cliente manda: elige un NIVEL del catálogo, nunca un
 * importe. Es la misma decisión que el catálogo de reacciones de truco —el cliente manda un
 * id y el servidor pone el contenido—, y acá pesa más, porque lo que el servidor pone es
 * cuánto se cobra.
 *
 * Vive en `rules/` y `core/config.ts` lo re-exporta: el nivel es lo que la legalidad de una
 * oferta JUZGA, así que es vocabulario de regla. El resto de `DominoMatchConfig` —el `seed`, los
 * asientos, la tasa— no lo es.
 */
export interface BetLevel {
  /**
   * EL MULTIPLICADOR DE LA MESA, y no un índice de una tabla: v1 usa 2, 3 y 5, y con él calcula
   * `entryFee * level` y `prize * level`. Por eso los montos NO viven acá — son una función de
   * la mesa, y esta lista viene del backend principal, que no sabe cuánto cuesta esta mesa.
   */
  readonly level: number;
  /** Se SUMA al multiplicador de la mesa al calcular los puntos de ranking (`multiplier + extra`). */
  readonly extra: number;
  /**
   * Los puntos de ranking que el ganador gana DE MÁS respecto a una partida sin aumento.
   *
   * Lo calcula el backend principal y viaja tal cual: la fórmula de puntos es suya, y
   * duplicarla en cada motor es exactamente cómo los dos lados se desincronizan. Es el mismo
   * argumento por el que el dominó no tiene `stakes.ts`.
   */
  readonly additionalPoints: number;
}

/**
 * LO QUE CUESTA Y LO QUE PAGA ACEPTAR UN NIVEL, derivado de la mesa.
 *
 * ⚠ ES UNA REGLA Y NO UN CAMPO, y ese fue un defecto real del modelo: `BetLevel` guardaba
 * `additionalEntryFee`/`additionalPrize` como si el catálogo los trajera, y el catálogo de v1
 * NO los tiene — devuelve `{ level, extra, additionalPoints }` y nada más. Un cobro cableado
 * contra esos campos habría cobrado CERO, en silencio, porque nadie los llenaba.
 *
 * La cuenta es la de v1 (`on-propose-bet-multiplier.ts:113-117`): la mesa entera se multiplica
 * por el nivel, y lo que se cobra es la DIFERENCIA. Vive en `rules/` porque el cliente la
 * necesita para mostrar el precio ANTES de proponer, que es cuándo el jugador decide.
 */
export function betAmountsOf(
  level: number,
  entryFee: number,
  prize: number,
): { readonly additionalEntryFee: number; readonly additionalPrize: number } {
  return {
    additionalEntryFee: entryFee * (level - 1),
    additionalPrize: prize * (level - 1),
  };
}

/**
 * LO QUE LAS REGLAS NECESITAN SABER DE LA MESA, y nada más. Dos campos, y ninguno es secreto.
 *
 * Nació de leer las firmas como si fueran una API: la legalidad de la apuesta pedía el
 * `DominoMatchConfig` COMPLETO para leer exactamente estos dos valores. Y ese tipo **contiene el
 * `seed`**: un cliente no puede construirlo ni debe (revelarlo permite predecir el reparto), así
 * que las reglas publicadas no se podían consumir sin un cast. Éste es el tipo que sí se puede.
 *
 * Lo satisfacen por estructura los dos lados, sin adaptador: el `DominoMatchConfig` del servidor
 * y el `PublicMatchConfig` que el front ya recibe de `GET /config/:roomId` traen los dos campos.
 * Es la misma idea que `MatchView`: un tipo angosto que lo ancho satisface tal cual.
 *
 * `pointsToWin` NO está acá aunque sea config de la mesa: vive en el ÁRBOL
 * (`MatchState.pointsToWin`), así que quien tiene la vista ya lo tiene y pedirlo dos veces
 * abriría la puerta a que la regla mire uno y el marcador el otro.
 */
export interface DominoRulesConfig {
  /**
   * LOS NIVELES DE AUMENTO que esta mesa ofrece. **Lista vacía = la mesa no ofrece aumentar**, y
   * ése es el reposo: el catálogo de niveles es de otro repo (en v1,
   * `internal/bet-increase/config` del backend principal) y el v1 falla CERRADO cuando no lo
   * consigue. Copiar ese default importa: con una lista que se llenara sola ante un error, una
   * mesa que no debía cobrar de más cobraría de más.
   */
  readonly betLevels: readonly BetLevel[];
  /**
   * Una mesa gratis NO PUEDE AUMENTAR, y es un chequeo propio en vez de deducirse de
   * `betLevels` vacío: son dos hechos distintos —"no hay catálogo" y "acá no se juega por
   * plata"— y un catálogo mal cargado sobre una mesa gratis terminaría cobrando una entrada
   * que nadie pagó.
   */
  readonly isFreeRoom: boolean;
}
