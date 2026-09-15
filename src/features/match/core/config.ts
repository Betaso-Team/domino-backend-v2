import type { PlayerRef } from "../../../shared/player-ref.js";
import type { PlayerId } from "./ids.js";

// Value-object INMUTABLE, fuera del estado de Colyseus e inyectado por DI.
// Acá vive el `seed`: hace el reparto determinista y reproducible, y como no está
// en el árbol no hay superficie por donde filtrarse al cliente (spec §7.1).
// Cómo se forman las parejas. Hoy el producto pide SHUFFLED; cambiar de modelo es
// cambiar este valor en la config del modo de juego, sin tocar el motor (spec §4.3).
export type TeamAssignmentMode = "SHUFFLED" | "SEAT_ORDER";

/**
 * UN ASIENTO DE LA MESA, congelado al crearse la partida. Junta las tres cosas que hasta
 * acá vivían separadas o no existían: el id OPACO con el que el motor lo nombra
 * (`playerId`), la identidad EXTERNA que lo autoriza (`PlayerRef`) y el perfil que el
 * front muestra.
 *
 * `currency` es la moneda YA COBRADA, no una preferencia del jugador: se congela acá
 * porque la recompensa se paga en la misma moneda de la inscripción, y releerla al
 * liquidar —cuando el jugador puede haberla cambiado en su perfil— es pagar en otra.
 *
 * `username` y `profilePicture` son OPCIONALES y el resto no: un invitado puede no tener
 * usuario ni foto, pero nadie juega sin nombre visible ni sin moneda cobrada.
 */
export interface MatchSeat extends PlayerRef {
  readonly playerId: PlayerId;
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
   * Lo COBRADO por asiento y el premio de la mesa, en UC menores: enteros seguros donde
   * los dos últimos dígitos son decimales (`1234 = 12,34 UC`). Enteros y no flotantes
   * porque `0.1 + 0.2` no es `0.3`, y acá el redondeo es plata de alguien.
   */
  readonly entryFeeUcMinor: number;
  readonly prizeUcMinor: number;
}

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
}

// Los plazos son los del v1, verificados en docs/reglas-de-juego-v1.md §5.1: 60 s de
// turno, idénticos en 2P, 4P y torneo. Los 30 s de gracia del v1 se conservan como
// CANTIDAD pero cambian de MODELO —de gracia por turno a reserva por partida—, que es
// un cambio deliberado escrito en el documento de reglas (decisión 7).
export const DEFAULT_GLOBAL_CONFIG: GlobalDominoConfig = {
  turnTimeoutMs: 60_000,
  extraTimeReserveMs: 30_000,
  // El número del v1 (`initialTilesTimeRemaining`).
  dealingTimeoutMs: 15_000,
  presentingRoundMs: 6_000,
  presentingMatchMs: 6_000,
  seatingTimeoutMs: 30_000,
  reconnectionWindowSeconds: 120,
  tilesPerPlayer: 7,
};

export function globalConfigWith(overrides: Partial<GlobalDominoConfig>): GlobalDominoConfig {
  return { ...DEFAULT_GLOBAL_CONFIG, ...overrides };
}
