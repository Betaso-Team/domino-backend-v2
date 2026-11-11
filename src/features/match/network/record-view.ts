import { UC } from "@/shared/money";
import type { SeatPrice } from "../core/config";
import { type SeatPriceView, seatPriceView, seatText, ucText } from "./amounts";
import type { StoredMatchRecord } from "./history";

// EL REGISTRO DE UNA PARTIDA COMO LO LEE EL PANEL, en la convención de montos v2 (`network/amounts.ts`):
// cada entidad con su `currency` y sus montos en texto. Mongo lo sigue guardando como siempre —números
// en UC (`*InUC`) y textos en la moneda del jugador (`*InPlayerCurrency`), con su `currency` en el
// precio— y estas funciones lo traducen AL SALIR por `GET /internal/matches`,
// `GET /internal/matches/:matchId`, `GET /game-data/:roomId` y `GET /internal/matches/:matchId/history`.
// Lo que no reconocen lo dejan como está: un documento de la forma vieja (`{ matchId, entries }`) sale
// igual, y un campo que falta no se inventa.
//
//   table.entryFeeInUC / prizeInUC              → table: { currency: "UC", entryFee, prize }
//   seats[].price, players[].price              → { currency, rateId?, rate, entry, prize, levels }
//   players[]: *InUC + *InPlayerCurrency        → { currency, rateId, charged, prizePaid } en la moneda
//                                                 del precio, o en UC si no la tiene
//   betMultiplier.resulting*InUC                → betMultiplier: { currency: "UC", resulting* }
//   timeline[] MULTIPLIER_AGREED.payload        → { currency: "UC", additionalEntryFee }
//
// LA MESA ESTÁ EN UC y CADA ASIENTO EN SU MONEDA: un asiento cerrado lleva el `rateId` de la partida, la
// tasa con la que billing cotizó su precio. El `currency` de un asiento cerrado es la moneda de SUS
// montos; un asiento sin precio (gratis, de antes) está en UC, y ahí el `currency` de la billetera que
// el armado congeló (`seats[].currency`) sigue en el asiento de `seats[]`.

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

/** La cabecera de la mesa: lo que cobraba y pagaba antes de cualquier aumento, en UC. */
export function tableView(table: unknown): unknown {
  if (!isDoc(table) || !isNumber(table.entryFeeInUC) || !isNumber(table.prizeInUC)) return table;
  return replaceKeys(table, ["entryFeeInUC", "prizeInUC"], {
    currency: UC,
    entryFee: ucText(table.entryFeeInUC),
    prize: ucText(table.prizeInUC),
  });
}

/** El precio de un asiento; sin `rateId` si el documento todavía no lo tiene (una partida abierta). */
function priceView(
  price: SeatPrice,
  rateId: string | undefined,
): SeatPriceView | Omit<SeatPriceView, "rateId"> {
  const view = seatPriceView(price, rateId ?? "");
  if (rateId !== undefined) return view;
  const { rateId: _none, ...rest } = view;
  return rest;
}

/**
 * Lo cobrado y lo pagado de un asiento cerrado, los dos en UNA moneda: la del precio si el cierre los
 * dejó en ella (`localMoneyOf` escribe los dos o ninguno), y si no en UC.
 */
function seatAmounts(seat: Doc, price: SeatPrice | undefined) {
  const charged = seat.chargedInPlayerCurrency;
  const paid = seat.prizePaidInPlayerCurrency;
  if (price !== undefined && typeof charged === "string" && typeof paid === "string") {
    return {
      currency: price.currency,
      charged: seatText(price, charged),
      prizePaid: seatText(price, paid),
    };
  }
  return {
    currency: UC,
    ...(isNumber(seat.chargedInUC) ? { charged: ucText(seat.chargedInUC) } : {}),
    ...(isNumber(seat.prizePaidInUC) ? { prizePaid: ucText(seat.prizePaidInUC) } : {}),
  };
}

const SEAT_MONEY_KEYS = [
  "chargedInUC",
  "chargedInPlayerCurrency",
  "prizePaidInUC",
  "prizePaidInPlayerCurrency",
] as const;

/** Un asiento del armado (`seats[]`) o del cierre (`players[]`). */
function seatView(seat: unknown, rateId: string | undefined): unknown {
  if (!isDoc(seat)) return seat;
  const price = isDoc(seat.price) ? (seat.price as unknown as SeatPrice) : undefined;
  let out: Doc = seat;
  if (price !== undefined) out = { ...out, price: priceView(price, rateId) };
  if (!isNumber(seat.chargedInUC) && !isNumber(seat.prizePaidInUC)) return out;
  // UN ASIENTO CON PLATA es una entidad en su moneda: `currency` (en el lugar del de la billetera, que
  // es la misma cuando hay precio) y la tasa de la partida, y después sus montos.
  const { currency, ...amounts } = seatAmounts(seat, price);
  out = replaceKeys(out, SEAT_MONEY_KEYS, amounts);
  const { currency: _wallet, ...rest } = out;
  return { currency, ...(rateId === undefined ? {} : { rateId }), ...rest };
}

function betMultiplierView(bet: unknown): unknown {
  if (!isDoc(bet)) return bet;
  const entryFee = bet.resultingEntryFeeInUC;
  const prize = bet.resultingPrizeInUC;
  if (!isNumber(entryFee) && !isNumber(prize)) return bet;
  return replaceKeys(bet, ["resultingEntryFeeInUC", "resultingPrizeInUC"], {
    currency: UC,
    ...(isNumber(entryFee) ? { resultingEntryFee: ucText(entryFee) } : {}),
    ...(isNumber(prize) ? { resultingPrize: ucText(prize) } : {}),
  });
}

/** Una entrada de la timeline: sólo `MULTIPLIER_AGREED` lleva plata, en UC como el evento de la sala. */
export function entryView<T>(entry: T): T {
  if (!isDoc(entry) || entry.type !== "MULTIPLIER_AGREED" || !isDoc(entry.payload)) return entry;
  const fee = entry.payload.additionalEntryFee;
  if (!isNumber(fee)) return entry;
  return {
    ...entry,
    payload: { ...entry.payload, currency: UC, additionalEntryFee: ucText(fee) },
  } as T;
}

/** El documento entero (el detalle y `/game-data`), o una fila del listado. */
export function recordView(stored: object): StoredMatchRecord {
  const record = stored as StoredMatchRecord;
  const rateId = typeof record.rateId === "string" ? record.rateId : undefined;
  const out: Record<string, unknown> = { ...record };
  if ("table" in record) out.table = tableView(record.table);
  for (const field of ["seats", "players"] as const) {
    const seats = record[field];
    if (Array.isArray(seats)) out[field] = seats.map((seat) => seatView(seat, rateId));
  }
  if ("betMultiplier" in record) out.betMultiplier = betMultiplierView(record.betMultiplier);
  // `entries` es la timeline de los documentos de la forma vieja.
  for (const field of ["timeline", "entries"] as const) {
    const entries = record[field];
    if (Array.isArray(entries)) out[field] = entries.map(entryView);
  }
  return out;
}
