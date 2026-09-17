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
  readonly level: number;
  readonly extra: number;
  readonly additionalEntryFee: number;
  readonly additionalPrize: number;
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
