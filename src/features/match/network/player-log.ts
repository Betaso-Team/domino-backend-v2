import { UC } from "@/shared/money";
import type { SeatPrice } from "../core/config";
import { seatText, ucText } from "./amounts";
import type { StoredMatchRecord } from "./history";
import { zeroLike } from "./player-currency";

// LO QUE JUGÓ UNA CUENTA: la otra mitad del registro, leída en vez de escrita. Portado de truco
// (`features/match/betaso/player-log.ts`), con la forma de respuesta de allá para que el cliente lea una
// sola. Es un puerto aparte de `MatchArchive` por lo mismo que ése va aparte de `HistoryPort`: tiene
// otro dueño —el jugador, no el panel— y otra pregunta.

/** Una partida vista desde el asiento del que pregunta. */
export interface MatchRow {
  /** El `matchId`: la clave estable de la fila. */
  readonly id: string;
  /**
   * La sala de Colyseus: lo que el jugador ve y le dicta a soporte. Truco no lo separa porque allá la
   * partida ES su sala; acá el `matchId` lo genera el dominó y la sala la genera Colyseus.
   */
  readonly roomId: string;
  /**
   * Cuándo terminó, como instante ISO. NO se formatea acá: una fecha armada en el servidor lleva la zona
   * horaria del servidor, y la noche que importa es la del jugador.
   */
  readonly playedAt: string;
  /**
   * LA MONEDA DE `bet` Y `prize` (convención de montos v2, `network/amounts.ts`): la del precio del
   * asiento (`VES`, el código tal cual), o `UC` si el asiento no tuvo precio (las gratis y las de antes)
   * o el cierre no lo dejó en su moneda.
   */
  readonly currency: string;
  /**
   * LO QUE PAGÓ Y LO QUE COBRÓ, con el aumento ya aplicado, como texto decimal en `currency`
   * (`"400.00"`), rellenado con sus decimales. En su moneda sale de lo que el registro congeló al cerrar
   * (`SeatMoney.*InPlayerCurrency`), así que una tasa nueva no cambia lo que dice una partida vieja; en
   * UC, de lo que cobró la mesa. Sin `uc` al lado.
   */
  readonly bet: string;
  readonly prize: string;
  /** Los puntos con que cerró su equipo. */
  readonly score: number;
  readonly result: MatchResult;
  readonly freeRoom: boolean;
  readonly playersQuantity: number;
  /** El modo COMO SE JUGÓ: el panel lo puede renombrar después. */
  readonly gameModeName: string;
}

/**
 * Cómo terminó PARA ÉL, que no es cómo terminó la partida. Cuatro y no tres: perder e irse dejan sin
 * premio a los dos, y el jugador sabe perfectamente cuál de las dos hizo.
 */
export type MatchResult = "win" | "lose" | "abandoned" | "canceled";

/** Una página, con la forma que sirve truco. */
export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
  readonly totalItems: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface PlayerLog {
  /**
   * Sólo las TERMINADAS (`finished` o `aborted`): la que está en curso todavía no tiene resultado. La
   * más nueva primero.
   * @param page desde 1, como cuenta el cliente.
   */
  pageOf(userId: string, page: number, perPage: number): Promise<Paginated<MatchRow>>;
}

/** Los estados que el historial del jugador muestra. */
export const ENDED_STATUSES = ["finished", "aborted"] as const;

interface StoredSeat {
  readonly id?: string;
  readonly userId?: string;
  readonly finalScore?: number;
  readonly chargedInUC?: number;
  readonly prizePaidInUC?: number;
  readonly chargedInPlayerCurrency?: string;
  readonly prizePaidInPlayerCurrency?: string;
  readonly price?: SeatPrice;
  readonly exit?: unknown;
}

const seatsOf = (document: StoredMatchRecord, field: "players" | "seats") =>
  (Array.isArray(document[field]) ? document[field] : []) as readonly StoredSeat[];

// EL ASIENTO CERRADO si lo hay y, si no, el del armado: una partida abortada antes de abrir no tiene
// `players`, pero sí sabe quién se había sentado.
const seatOf = (userId: string, document: StoredMatchRecord): StoredSeat | undefined =>
  seatsOf(document, "players").find((seat) => seat.userId === userId) ??
  seatsOf(document, "seats").find((seat) => seat.userId === userId);

/**
 * CÓMO TERMINÓ PARA ÉL, derivado y no guardado, porque es el único campo que depende de QUIÉN pregunta.
 * Los ganadores son ASIENTOS (`seat-N`) y no cuentas: primero se cruza la cuenta con su asiento.
 */
export function resultFor(userId: string, document: StoredMatchRecord): MatchResult {
  if (document.status === "aborted") return "canceled";
  const seat = seatOf(userId, document);
  const winners = (Array.isArray(document.winnerIds) ? document.winnerIds : []) as string[];
  if (seat?.id !== undefined && winners.includes(seat.id)) return "win";
  // DESPUÉS de ganar, y ese orden es la sutileza: en 4P uno se puede ir de una partida que su pareja
  // termina ganando, y lo que va a recordar es que ganó.
  if (seat?.exit !== undefined) return "abandoned";
  return "lose";
}

const isoOf = (value: unknown) => (value instanceof Date ? value.toISOString() : undefined);

export function rowOf(userId: string, document: StoredMatchRecord): MatchRow {
  const seat = seatOf(userId, document);
  const result = resultFor(userId, document);
  const table = (document.table ?? {}) as {
    name?: string;
    isFree?: boolean;
    entryFeeInUC?: number;
  };
  const config = (document.matchConfig ?? {}) as { playersQuantity?: number };
  return {
    id: String(document.matchId ?? ""),
    roomId: String(document.roomId ?? ""),
    playedAt:
      isoOf(document.matchEndedAt) ??
      isoOf(document.updatedAt) ??
      isoOf(document.createdAt) ??
      new Date(0).toISOString(),
    ...amountsFor(seat, table, result),
    score: seat?.finalScore ?? 0,
    result,
    freeRoom: table.isFree ?? false,
    playersQuantity: config.playersQuantity ?? seatsOf(document, "seats").length,
    gameModeName: table.name ?? "",
  };
}

// `bet` Y `prize`, con las MISMAS dos reglas en las dos monedas:
//   · UNA CANCELADA NO MOVIÓ PLATA PARA ÉL: el reembolso lo decide el orquestador por su ficha, y
//     mostrar la entrada sería mostrar un cobro que se devolvió.
//   · Y el premio es sólo del que ganó: el resto se llevó nada, que es lo que el campo tiene que decir.
// Lo cobrado y lo pagado en su moneda salen del cierre, que ya eligió el nivel del aumento; sin cierre
// en el asiento —o sin precio— no se adivina y la fila queda en UC.
function amountsFor(
  seat: StoredSeat | undefined,
  table: { readonly entryFeeInUC?: number },
  result: MatchResult,
): Pick<MatchRow, "currency" | "bet" | "prize"> {
  const betUc = result === "canceled" ? 0 : (seat?.chargedInUC ?? table.entryFeeInUC ?? 0);
  const prizeUc = result === "win" ? (seat?.prizePaidInUC ?? 0) : 0;
  const local = inPlayerCurrency(seat, result);
  const price = seat?.price;
  if (price === undefined || local === undefined) {
    return { currency: UC, bet: ucText(betUc), prize: ucText(prizeUc) };
  }
  return {
    currency: price.currency,
    bet: seatText(price, local.bet),
    prize: seatText(price, local.prize),
  };
}

function inPlayerCurrency(
  seat: StoredSeat | undefined,
  result: MatchResult,
): { readonly bet: string; readonly prize: string } | undefined {
  const price = seat?.price;
  if (price === undefined) return undefined;
  if (result === "canceled") return { bet: zeroLike(price.entry), prize: zeroLike(price.prize) };
  const charged = seat?.chargedInPlayerCurrency;
  const paid = seat?.prizePaidInPlayerCurrency;
  if (charged === undefined || paid === undefined) return undefined;
  return { bet: charged, prize: result === "win" ? paid : zeroLike(price.prize) };
}

export function paginated<T>(
  items: readonly T[],
  totalItems: number,
  page: number,
  perPage: number,
): Paginated<T> {
  const totalPages = Math.ceil(totalItems / perPage);
  return {
    items,
    page,
    perPage,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
