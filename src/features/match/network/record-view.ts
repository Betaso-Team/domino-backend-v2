import { UC_KEY, readAmount } from "@/shared/money";
import type { SeatPrice } from "../core/config";
import { seatMoneyOf, seatPriceView, ucOf } from "./amounts";
import type { StoredMatchRecord } from "./history";

// EL REGISTRO DE UNA PARTIDA COMO LO LEE EL PANEL, en la convención de montos (`network/amounts.ts`).
// Mongo lo sigue guardando como siempre —números en UC (`*InUC`) y textos en la moneda del jugador
// (`*InPlayerCurrency`), con su `currency` en el precio— y estas funciones lo traducen AL SALIR por
// `GET /internal/matches`, `GET /internal/matches/:matchId`, `GET /game-data/:roomId` y
// `GET /internal/matches/:matchId/history`. Lo que no reconocen lo dejan como está: un documento de la
// forma vieja (`{ matchId, entries }`) sale igual, y un campo que falta no se inventa.
//
//   table.entryFeeInUC / prizeInUC                        → table.entryFee / prize: { uc }
//   seats[].price, players[].price                        → { rate, entry, prize, levels } con su moneda y `uc`
//   players[].chargedInUC + chargedInPlayerCurrency       → players[].charged: { <moneda>?, uc }
//   players[].prizePaidInUC + prizePaidInPlayerCurrency   → players[].prizePaid: { <moneda>?, uc }
//   betMultiplier.resultingEntryFeeInUC / …PrizeInUC      → betMultiplier.resultingEntryFee / …Prize: { uc }
//   timeline[] MULTIPLIER_AGREED.payload.additionalEntryFee → { uc }

type Doc = Readonly<Record<string, unknown>>;

const isDoc = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Reemplaza las llaves `from` por `to` → valor, en el lugar de la primera, sin mover las demás. */
function replaceKeys(
  doc: Doc,
  from: readonly string[],
  to: Readonly<Record<string, unknown>>,
): Doc {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(doc)) {
    if (!from.includes(key)) {
      out[key] = value;
      continue;
    }
    if (!placed) Object.assign(out, to);
    placed = true;
  }
  return out;
}

/** La cabecera de la mesa: lo que cobraba y pagaba antes de cualquier aumento, en `{ uc }`. */
export function tableView(table: unknown): unknown {
  if (!isDoc(table) || !isNumber(table.entryFeeInUC) || !isNumber(table.prizeInUC)) return table;
  return replaceKeys(table, ["entryFeeInUC", "prizeInUC"], {
    entryFee: ucOf(table.entryFeeInUC),
    prize: ucOf(table.prizeInUC),
  });
}

/** Un monto en la moneda del asiento si el registro lo tiene, siempre con su `uc`. */
function seatAmount(price: SeatPrice | undefined, inUc: number, inSeat: unknown) {
  return price !== undefined && typeof inSeat === "string"
    ? seatMoneyOf(price, inSeat, readAmount(inUc, UC_KEY))
    : ucOf(inUc);
}

/** Un asiento del armado (`seats[]`) o del cierre (`players[]`). */
function seatView(seat: unknown, table: Doc | undefined): unknown {
  if (!isDoc(seat)) return seat;
  const price = isDoc(seat.price) ? (seat.price as unknown as SeatPrice) : undefined;
  let out: Doc = seat;
  if (price !== undefined && table && isNumber(table.entryFeeInUC) && isNumber(table.prizeInUC)) {
    out = {
      ...out,
      price: seatPriceView(price, { entryFee: table.entryFeeInUC, prize: table.prizeInUC }),
    };
  }
  if (isNumber(seat.chargedInUC)) {
    out = replaceKeys(out, ["chargedInUC", "chargedInPlayerCurrency"], {
      charged: seatAmount(price, seat.chargedInUC, seat.chargedInPlayerCurrency),
    });
  }
  if (isNumber(seat.prizePaidInUC)) {
    out = replaceKeys(out, ["prizePaidInUC", "prizePaidInPlayerCurrency"], {
      prizePaid: seatAmount(price, seat.prizePaidInUC, seat.prizePaidInPlayerCurrency),
    });
  }
  return out;
}

function betMultiplierView(bet: unknown): unknown {
  if (!isDoc(bet)) return bet;
  let out = bet;
  if (isNumber(bet.resultingEntryFeeInUC)) {
    out = replaceKeys(out, ["resultingEntryFeeInUC"], {
      resultingEntryFee: ucOf(bet.resultingEntryFeeInUC),
    });
  }
  if (isNumber(bet.resultingPrizeInUC)) {
    out = replaceKeys(out, ["resultingPrizeInUC"], {
      resultingPrize: ucOf(bet.resultingPrizeInUC),
    });
  }
  return out;
}

/** Una entrada de la timeline: sólo `MULTIPLIER_AGREED` lleva plata. */
export function entryView<T>(entry: T): T {
  if (!isDoc(entry) || entry.type !== "MULTIPLIER_AGREED" || !isDoc(entry.payload)) return entry;
  const fee = entry.payload.additionalEntryFee;
  if (!isNumber(fee)) return entry;
  return { ...entry, payload: { ...entry.payload, additionalEntryFee: ucOf(fee) } } as T;
}

/** El documento entero (el detalle y `/game-data`), o una fila del listado. */
export function recordView(stored: object): StoredMatchRecord {
  const record = stored as StoredMatchRecord;
  const table = isDoc(record.table) ? record.table : undefined;
  const out: Record<string, unknown> = { ...record };
  if ("table" in record) out.table = tableView(record.table);
  for (const field of ["seats", "players"] as const) {
    const seats = record[field];
    if (Array.isArray(seats)) out[field] = seats.map((seat) => seatView(seat, table));
  }
  if ("betMultiplier" in record) out.betMultiplier = betMultiplierView(record.betMultiplier);
  // `entries` es la timeline de los documentos de la forma vieja.
  for (const field of ["timeline", "entries"] as const) {
    const entries = record[field];
    if (Array.isArray(entries)) out[field] = entries.map(entryView);
  }
  return out;
}
