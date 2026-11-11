import { UC, UC_DECIMALS, fixed, readAmount } from "@/shared/money";
import type { SeatPrice } from "../core/config";
import type { NetworkMatchEvent } from "./events";

// LOS MONTOS QUE EL DOMINÓ EMITE, en la convención de Tablea Gaming (`docs/convenciones/montos.md` del
// orquestador, v2): cada ENTIDAD lleva un `currency`, y todos sus montos están en esa moneda como texto
// decimal plano, rellenado con los decimales de la moneda y nunca redondeado —`{ currency: "UC",
// entryFee: "2.0000" }`—. Sin `uc` al lado: un registro cobrado con una tasa expone su `rateId`, y quien
// quiera el UC consulta esa tasa. Adentro nada cambia: el motor, el snapshot y el registro en Mongo
// siguen guardando los números en UC y los textos en la moneda del jugador; la forma es de la FRONTERA
// (el mensaje `config`, `GET /config/:roomId`, el estado y los eventos de la sala, el resultado por
// RabbitMQ y las lecturas del historial).
//
// DE DÓNDE SALE CADA ENTIDAD:
//   · la MESA está en UC (`currency: "UC"`): sus números son los del catálogo del orquestador,
//     congelados en el snapshot, y es lo que cobra billing.
//   · cada ASIENTO con precio está en su moneda (`MatchSeat.price.currency`, el código tal cual): los
//     textos que billing cotizó, rellenados con `price.decimals` si el orquestador los mandó y tal cual
//     si no. Con el `rateId` de la mesa, que es la tasa con la que se cotizaron.
// Un asiento sin precio (mesa gratis, orquestador viejo, partida grabada antes) está en UC: el dominó no
// sabe cuánto fue en la otra moneda, y no lo inventa.

/**
 * UN NÚMERO EN UC COMO TEXTO, con su forma decimal más corta y los 4 decimales de UC rellenados. NUNCA
 * REDONDEA, ni siquiera el ruido de coma flotante de un producto (`0.1 × 3`): el texto vuelve al MISMO
 * `number` con `Number(texto)`, que es lo que el orquestador compara contra su planilla al leer el
 * resultado (`payouts[].amount`). Redondear acá podía dar un premio que no coincide y un mensaje en la DLQ.
 */
export function ucText(amount: number): string {
  return fixed(readAmount(amount, UC), UC_DECIMALS);
}

/**
 * UN MONTO EN LA MONEDA DE UN ASIENTO, el texto que billing cotizó rellenado con los decimales de la
 * moneda (`price.decimals`; los 4 de UC si el asiento paga en UC). Sin decimales sale como vino:
 * `fixed(texto, 0)` nunca quita un dígito.
 */
export function seatText(price: Pick<SeatPrice, "currency" | "decimals">, amount: string): string {
  return fixed(amount, price.currency === UC ? UC_DECIMALS : (price.decimals ?? 0));
}

/** El precio de un asiento en la convención: una entidad en su moneda, con la tasa de la mesa. */
export interface SeatPriceView {
  /** El código de la moneda tal cual lo cotizó billing (`VES`). */
  readonly currency: string;
  /** La tasa de la mesa (`DominoMatchConfig.rateId`): con ella se cotizó cada monto de abajo. */
  readonly rateId: string;
  /** Lo que vale 1 UC en `currency`, como lo congeló billing. No es un monto. */
  readonly rate: string;
  readonly entry: string;
  readonly prize: string;
  readonly levels: readonly {
    readonly level: number;
    /** Lo que COBRA subir a ese nivel (no acumulado). */
    readonly entry: string;
    /** El premio de cada ganador a ese nivel. */
    readonly prize: string;
  }[];
}

/**
 * EL PRECIO DE UN ASIENTO EN LA CONVENCIÓN, campo por campo: el precio del snapshot es el que validó el
 * contrato, y un campo que se le sume mañana no tiene por qué salir solo. Los `decimals` no salen: ya
 * están en el relleno de cada monto.
 *
 * @param rateId la tasa de la mesa.
 */
export function seatPriceView(price: SeatPrice, rateId: string): SeatPriceView {
  return {
    currency: price.currency,
    rateId,
    rate: price.rate,
    entry: seatText(price, price.entry),
    prize: seatText(price, price.prize),
    levels: price.levels.map(({ level, entry, prize }) => ({
      level,
      entry: seatText(price, entry),
      prize: seatText(price, prize),
    })),
  };
}

/** Un evento de la sala como sale al cliente (`broadcast("events")`) y a la timeline que se lee. */
export type WireMatchEvent =
  | Exclude<NetworkMatchEvent, { type: "MULTIPLIER_AGREED" }>
  | (Omit<Extract<NetworkMatchEvent, { type: "MULTIPLIER_AGREED" }>, "additionalEntryFee"> & {
      readonly currency: typeof UC;
      readonly additionalEntryFee: string;
    });

/**
 * LOS EVENTOS EN LA CONVENCIÓN. El único con plata es `MULTIPLIER_AGREED`, cuyo `additionalEntryFee` (lo
 * que le cuesta aceptar a cada asiento) está en UC: el evento va a toda la mesa, así que sale como
 * entidad en UC (`currency: "UC"`, `additionalEntryFee: "125.0000"`), y la misma cifra en la moneda de
 * cada uno está en su `seatPrices[seat].levels`. Adentro el evento sigue siendo un número: lo lee el
 * cobro del aumento (`OrchestratorBetCharger`) y lo graba la timeline.
 */
export function wireEventOf(event: NetworkMatchEvent): WireMatchEvent {
  if (event.type !== "MULTIPLIER_AGREED") return event;
  return { ...event, currency: UC, additionalEntryFee: ucText(event.additionalEntryFee) };
}
