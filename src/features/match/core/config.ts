import type { PlayerId } from "./ids";
import type { BetLevel } from "./rules/config";

// Value-object INMUTABLE, fuera del estado de Colyseus e inyectado por DI.
// Acá vive el `seed`: hace el reparto determinista y reproducible, y como no está
// en el árbol no hay superficie por donde filtrarse al cliente (spec §7.1).
// Cómo se forman las parejas. Hoy el producto pide SHUFFLED; cambiar de modelo es
// cambiar este valor en la config del modo de juego, sin tocar el motor (spec §4.3).
export type TeamAssignmentMode = "SHUFFLED" | "SEAT_ORDER";

/**
 * UN ASIENTO DE LA MESA, congelado al crearse la partida. Junta las tres cosas que hasta
 * acá vivían separadas o no existían: el id OPACO con el que el motor lo nombra
 * (`playerId`), la identidad EXTERNA que lo autoriza (`userId`) y el perfil que el
 * front muestra.
 *
 * `userId` es el `sub` del token y la MISMA cadena que `Identity.userId` de `features/auth`:
 * un solo vocabulario de identidad en todo el repo, que es el de truco y el del v1 del
 * dominó. No se declara importando `Identity` porque el core solo puede importar de su
 * propia feature y de `shared/` (Regla 1), y un campo `string` no justifica una interfaz
 * compartida.
 *
 * `currency` es la moneda YA COBRADA, no una preferencia del jugador: se congela acá
 * porque la recompensa se paga en la misma moneda de la inscripción, y releerla al
 * liquidar —cuando el jugador puede haberla cambiado en su perfil— es pagar en otra.
 *
 * `username` y `profilePicture` son OPCIONALES y el resto no: un invitado puede no tener
 * usuario ni foto, pero nadie juega sin nombre visible ni sin moneda cobrada.
 */
export interface MatchSeat {
  readonly playerId: PlayerId;
  readonly userId: string;
  readonly displayName: string;
  readonly username?: string;
  readonly profilePicture?: string;
  readonly currency: string;
}

export interface DominoMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seed: string;
  readonly seats: readonly MatchSeat[];
  readonly pointsToWin: number;
  readonly teamAssignment: TeamAssignmentMode;
  /**
   * ¿La mano se reparte tapada y hay que pedirla? (reglas §3.1). A diferencia de
   * `teamAssignment` **no depende del modo ni de los asientos**: va en toda mesa, porque
   * es el control de presencia del arranque. Es config igual, por dos razones: producto
   * tiene que poder apagarla sin deploy, y los tests de integración del motor —que
   * prueban la tranca o el conteo, no esto— no tienen por qué pagar la ceremonia.
   */
  readonly isDealWindowEnabled: boolean;
  /**
   * LA TASA DE LA MESA, una sola para toda la partida. Es el identificador de la
   * conversión con la que se cobró, y toda recompensa o reembolso usa ÉSTA: tomar la
   * vigente al liquidar pagaría un premio calculado con una tasa que el jugador nunca
   * aceptó.
   */
  readonly rateId: string;
  /**
   * Lo COBRADO por asiento y el premio de la mesa, en UC COMPLETAS: `entryFee: 10` son
   * diez UC, no diez centésimos. Es la convención del catálogo de v1, que es de donde
   * salen estos dos números, y copiarla sin escalar es lo que impide que la mesa cobre
   * cien veces de menos.
   *
   * SON NÚMEROS FINITOS NO NEGATIVOS Y PUEDEN TRAER DECIMALES (`1.5` es un UC y medio):
   * un modo productivo los tiene así. Acá NO se hace aritmética con ellos —se copian a la
   * instrucción de liquidación tal cual—, así que el `0.1 + 0.2` que justificaría enteros
   * no ocurre en este repo: quien convierta a la moneda del jugador con el `rateId` es el
   * que decide el redondeo, y es el único que puede decidirlo.
   */
  readonly entryFee: number;
  readonly prize: number;
  /**
   * EL PESO DE LA MESA EN EL RANKING, congelado con el resto. Es el `multiplier` del modo de
   * juego, y multiplica los PUNTOS que el ganador suma al ranking — **no el premio**, que sale de
   * `prize`. Confundirlos es pagar de más.
   *
   * EL MOTOR NO LO LEE, y por eso llegó tarde: las piedras de una ronda se cuentan igual en una
   * mesa de peso 1 que en una de peso 5. Lo consume el reporte del cierre
   * (`network/report-standings.ts`), que suma `acceptedBetExtra` encima — así lo hace v1
   * (`domino-room-state.ts:582`), y esa suma es la razón por la que el peso tiene que estar
   * congelado acá y no releerse del catálogo al cerrar: el modo pudo cambiar de peso mientras la
   * partida se jugaba.
   */
  readonly multiplier: number;
  /**
   * LOS NIVELES DE AUMENTO que esta mesa ofrece, congelados al crearse igual que el resto.
   * **Lista vacía = la mesa no ofrece aumentar**, y ése es el reposo: el catálogo de niveles
   * es de otro repo (en v1, `internal/bet-increase/config` del backend principal) y el v1
   * falla CERRADO cuando no lo consigue. Copiar ese default importa: con una lista que se
   * llenara sola ante un error, una mesa que no debía cobrar de más cobraría de más.
   */
  readonly betLevels: readonly BetLevel[];
  /**
   * SI ESTA MESA OFRECE REVANCHA. Hoy lo decide el modo —casual sí, torneo no: ahí se vuelve a
   * jugar cuando el torneo lo diga, no cuando los jugadores se pongan de acuerdo— y se congela
   * con el resto porque la mesa no puede cambiar de reglas mientras se juega.
   *
   * NO ES LO MISMO QUE PODER PAGARLA, y ésa es la distinción que justifica el campo: sin él, un
   * torneo mostraría el botón de revancha apagado, diciéndole al jugador que le falta saldo
   * cuando lo que pasa es que la revancha no existe ahí. Con esto en `false` la ventana ni
   * siquiera se abre. Lo otro —saldo, antifraude, cadena— viaja en `RematchState.eligible`.
   */
  readonly isRematchEnabled: boolean;
  /**
   * Una mesa gratis NO PUEDE AUMENTAR, y es un chequeo propio en vez de deducirse de
   * `betLevels` vacío: son dos hechos distintos —"no hay catálogo" y "acá no se juega por
   * plata"— y un catálogo mal cargado sobre una mesa gratis terminaría cobrando una entrada
   * que nadie pagó.
   */
  readonly isFreeRoom: boolean;
  /**
   * SI ESTA MESA REEMPLAZA CON UNA MÁQUINA al que se retira. Sale del catálogo y se congela con
   * el resto: una mesa no puede cambiar de reglas mientras se juega, y menos ésta —el panel
   * apagando los bots a mitad de partida le sacaría al compañero el socio que ya tiene sentado—.
   * Lo que decide CUÁNDO se sienta uno es `canSeatBot`, en `rules/bot.ts`.
   */
  readonly enableBots: boolean;
}

// El nivel se declara en `rules/config` —es lo que la legalidad de una oferta JUZGA, así que
// es vocabulario de regla— y se re-exporta acá, que es de donde lo importaba todo el mundo.
// `DominoMatchConfig` satisface `DominoRulesConfig` por estructura: los tres campos que las
// reglas necesitan (`betLevels`, `isFreeRoom`, `enableBots`) están arriba, sin adaptador y sin
// cast.
export type { BetLevel };

/** Los ids OPACOS de la mesa, en orden de asiento. Es lo único que el motor consume. */
export const playerIdsOf = (config: DominoMatchConfig): readonly PlayerId[] =>
  config.seats.map(({ playerId }) => playerId);

export interface GlobalDominoConfig {
  /** El plazo normal del turno. Se reinicia en cada turno. */
  readonly turnTimeoutMs: number;
  /**
   * La RESERVA de tiempo extra con la que cada jugador arranca la partida. NO es una
   * gracia por turno: es un saldo que solo decrece durante toda la partida (reglas §5.1,
   * decisión 7). El arranque lo siembra en `PlayerState.extraTimeRemainingMs`.
   */
  readonly extraTimeReserveMs: number;
  /**
   * La VENTANA DE REPARTO (reglas §3.1): cuánto tiene cada uno para levantar sus fichas
   * al empezar la partida. Es el plazo más corto de la mesa y el único que controla a
   * TODOS a la vez —el del turno solo mira al que le toca jugar—, y por eso es el que
   * agarra al que se sentó, vio lo que le tocó y se fue.
   */
  readonly dealingTimeoutMs: number;
  readonly presentingRoundMs: number;
  readonly presentingMatchMs: number;
  readonly seatingTimeoutMs: number;
  /**
   * Cuánto se le guarda el asiento al que se cayó. En SEGUNDOS —no en ms como los
   * demás— porque es la unidad de `allowReconnection`, y traducir en el medio dejaría
   * dos números para el mismo plazo.
   *
   * Es el único plazo de esta config que el MOTOR no lee: lo consume la sala. Vive acá
   * igual porque `GlobalDominoConfig` es el sobre en el que la partida recibe sus plazos
   * y la sala ya lo resuelve para `seatingTimeoutMs`; un segundo canal para un solo
   * número sería una vía paralela de configuración que nadie recordaría mantener.
   */
  readonly reconnectionWindowSeconds: number;
  readonly tilesPerPlayer: number;
  /**
   * Cuánto tiene el rival para contestar un aumento de apuesta. Al vencer NO se queda en
   * silencio: se responde que NO en su nombre (reglas de v1), porque la mesa está congelada
   * esperando y el turno de otro no puede quedar rehén de una propuesta que nadie contesta.
   */
  readonly betResponseTimeoutMs: number;
  /**
   * LOS TRES PLAZOS DE LA REVANCHA, y son tres porque esperan tres cosas distintas.
   *
   * `rematchWindowMs` es cuánto queda el botón en pantalla sin que nadie lo apriete.
   * `rematchResponseMs` es cuánto tiene el resto de la mesa para contestar una solicitud, y es
   * MUCHO más corto a propósito: el que pidió está mirando una pantalla que no avanza.
   * `rematchHandoffMs` es lo que la sala VIEJA se sostiene después de que todos aceptaron —la
   * nueva ya existe y cada uno tiene su reserva, pero soltarla antes de que el cliente la
   * consuma lo deja sin la partida que acaba de aceptar—.
   *
   * Los tres números son los de v1 (`OPEN_WINDOW_MS`, `RESPONSE_WINDOW_MS`,
   * `ACCEPTED_HANDOFF_MS`), y el del traspaso lleva su margen adentro: v1 lo eligió como «>3 s
   * de pantalla de revancha aceptada» más lo que tarda el cliente en entrar a la sala nueva.
   */
  readonly rematchWindowMs: number;
  readonly rematchResponseMs: number;
  readonly rematchHandoffMs: number;
  /**
   * CUÁNTO PIENSA LA MÁQUINA antes de jugar. Es el número de v1 (`playBotTile`, 1500 ms) y no es
   * decoración: sin espera el bot juega en el mismo tick en que le llega el turno, la mesa se
   * mueve sola y el que está mirando no alcanza a ver qué pasó.
   *
   * Es el otro plazo que el MOTOR no lee —lo consume `BotTurnTaker`, que es de la red, porque los
   * comandos son síncronos y esto tiene que esperar—. Vive acá por lo mismo que
   * `reconnectionWindowSeconds`: éste es el sobre en el que la mesa recibe sus plazos.
   */
  readonly botTurnDelayMs: number;
}

// Los plazos son los del v1, verificados en docs/reglas-de-juego-v1.md §5.1: 60 s de
// turno, idénticos en 2P, 4P y torneo. Los 30 s de gracia del v1 se conservan como
// CANTIDAD pero cambian de MODELO —de gracia por turno a reserva por partida—, que es
// un cambio deliberado escrito en el documento de reglas (decisión 7).
export const DEFAULT_GLOBAL_CONFIG: GlobalDominoConfig = {
  turnTimeoutMs: 60_000,
  extraTimeReserveMs: 30_000,
  // El número del v1 (`initialTilesTimeRemaining`).
  dealingTimeoutMs: 20_000,
  presentingRoundMs: 4_000,
  presentingMatchMs: 4_000,
  seatingTimeoutMs: 30_000,
  reconnectionWindowSeconds: 120,
  tilesPerPlayer: 7,
  // El número del v1 (`actionResponseTimeRemaining` del que responde un aumento).
  betResponseTimeoutMs: 10_000,
  // El número del v1 (`playBotTile`).
  botTurnDelayMs: 1_500,
  // Los tres del v1 (`rematch-manager.ts`).
  rematchWindowMs: 30_000,
  rematchResponseMs: 5_000,
  rematchHandoffMs: 6_000,
};

// CON LO QUE NACE UNA MESA NUEVA. Una FUNCIÓN y no un valor porque se pregunta por mesa y nunca se
// captura: entre una mesa y la siguiente los números pueden haberse movido (config editable en
// caliente, `features/settings`), y una mesa ya en juego no tiene que enterarse.
export type GlobalConfigSource = () => GlobalDominoConfig;

export function globalConfigWith(overrides: Partial<GlobalDominoConfig>): GlobalDominoConfig {
  return { ...DEFAULT_GLOBAL_CONFIG, ...overrides };
}
