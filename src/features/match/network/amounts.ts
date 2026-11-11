import { type Money, UC_KEY, fixed, money, readAmount, ucOnly } from "@/shared/money";
import type { SeatPrice } from "../core/config";
import type { NetworkMatchEvent } from "./events";

// LOS MONTOS QUE EL DOMINÓ EMITE, en la convención de Tablea Gaming (`docs/convenciones/montos.md` del
// orquestador): un objeto con una llave por moneda, en minúsculas, y el monto en texto decimal —
// `{ ves: "200.00", uc: "2.0000" }`—, sin `currency` al lado. Adentro nada cambia: el motor, el snapshot
// y el registro en Mongo siguen guardando los números en UC y los textos en la moneda del jugador; la
// forma es de la FRONTERA (el mensaje `config`, `GET /config/:roomId`, el estado y los eventos de la
// sala, el resultado por RabbitMQ y las lecturas del historial).
//
// DE DÓNDE SALE CADA LLAVE:
//   · `uc`: el número en UC de la mesa (el catálogo del orquestador, congelado en el snapshot). Nunca se
//     reconvierte desde la moneda del jugador con la tasa: el UC es el dato y el otro es su cotización.
//   · la moneda del jugador: el texto que billing cotizó (`MatchSeat.price`), rellenado con los decimales
//     de la moneda si el orquestador los mandó (`price.decimals`) y tal cual si no.
// Un monto sin precio en la moneda del jugador (mesa gratis, orquestador viejo, partida grabada antes)
// sale `{ uc }` solo: el dominó no sabe cuánto fue en la otra moneda, y no lo inventa.

/**
 * UN NÚMERO EN UC COMO `{ uc }`, con su forma decimal más corta y los 4 decimales de UC rellenados.
 * NUNCA REDONDEA, ni siquiera el ruido de coma flotante de un producto (`0.1 × 3`): el texto vuelve al
 * MISMO `number` con `Number(texto)`, que es lo que el orquestador compara contra su planilla al leer el
 * resultado (`payouts[].amount`). Redondear acá podía dar un premio que no coincide y un mensaje en la DLQ.
 */
export function ucOf(amount: number): Money {
  return ucOnly(readAmount(amount, UC_KEY));
}

/** Un monto en UC por un entero (`level`), EXACTO: sobre el texto, con `bigint`. */
function ucTimes(amount: number, factor: number): string {
  const text = fixed(readAmount(amount, UC_KEY), 0);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const digits = (BigInt(whole + fraction) * BigInt(factor))
    .toString()
    .padStart(fraction.length + 1, "0");
  const unsigned =
    fraction.length === 0
      ? digits
      : `${digits.slice(0, -fraction.length)}.${digits.slice(-fraction.length)}`;
  return fixed(negative ? `-${unsigned}` : unsigned, 0);
}

/**
 * UN MONTO EN LA MONEDA DE UN ASIENTO, con su `uc`. Si la moneda del asiento ES UC, el objeto es `{ uc }`
 * solo, con el texto del precio (los dos dicen lo mismo y `money` no admite dos UC distintos).
 */
export function seatMoneyOf(
  price: Pick<SeatPrice, "currency" | "decimals">,
  amount: string,
  uc: string,
): Money {
  if (price.currency.toLowerCase() === UC_KEY) return ucOnly(amount);
  return money(price.currency, amount, price.decimals ?? 0, uc);
}

/** El precio de un asiento en la convención: la tasa como vino y cada monto con su `uc`. */
export interface SeatPriceView {
  readonly rate: string;
  readonly entry: Money;
  readonly prize: Money;
  readonly levels: readonly {
    readonly level: number;
    /** Lo que COBRA subir a ese nivel (no acumulado). */
    readonly entry: Money;
    /** El premio de cada ganador a ese nivel. */
    readonly prize: Money;
  }[];
}

/**
 * EL PRECIO DE UN ASIENTO EN LA CONVENCIÓN. El `uc` de cada monto sale de la mesa con la MISMA regla
 * que el cobro (`betAmountsOf`): subir al nivel N cobra `entryFee × (N − 1)` y paga `prize × N`. La
 * `currency` del precio desaparece: es la llave de cada monto.
 *
 * @param table lo que la mesa cobra y paga en UC, antes de cualquier aumento.
 */
export function seatPriceView(
  price: SeatPrice,
  table: { readonly entryFee: number; readonly prize: number },
): SeatPriceView {
  return {
    rate: price.rate,
    entry: seatMoneyOf(price, price.entry, readAmount(table.entryFee, UC_KEY)),
    prize: seatMoneyOf(price, price.prize, readAmount(table.prize, UC_KEY)),
    levels: price.levels.map(({ level, entry, prize }) => ({
      level,
      entry: seatMoneyOf(price, entry, ucTimes(table.entryFee, level - 1)),
      prize: seatMoneyOf(price, prize, ucTimes(table.prize, level)),
    })),
  };
}

/** Un evento de la sala como sale al cliente (`broadcast("events")`) y a la timeline que se lee. */
export type WireMatchEvent =
  | Exclude<NetworkMatchEvent, { type: "MULTIPLIER_AGREED" }>
  | (Omit<Extract<NetworkMatchEvent, { type: "MULTIPLIER_AGREED" }>, "additionalEntryFee"> & {
      readonly additionalEntryFee: Money;
    });

/**
 * LOS EVENTOS EN LA CONVENCIÓN. El único con plata es `MULTIPLIER_AGREED`, cuyo `additionalEntryFee` (lo
 * que le cuesta aceptar a cada asiento, en UC) sale como `{ uc }`: el evento va a toda la mesa, y la
 * misma cifra en la moneda de cada uno está en su `seatPrices[seat].levels`. Adentro el evento sigue
 * siendo un número: lo lee el cobro del aumento (`OrchestratorBetCharger`) y lo graba la timeline.
 */
export function wireEventOf(event: NetworkMatchEvent): WireMatchEvent {
  if (event.type !== "MULTIPLIER_AGREED") return event;
  return { ...event, additionalEntryFee: ucOf(event.additionalEntryFee) };
}
