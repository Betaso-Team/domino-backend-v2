import type { SeatPrice } from "../core/config";

// LA PLATA DE UN ASIENTO EN LA MONEDA DEL JUGADOR, ELEGIDA Y NO CONVERTIDA. El dominó no tiene tasa ni
// redondeo propios: billing cotizó cada número que la mesa puede mover (`MatchSeat.price`) y acá sólo se
// toma el que corresponde con la MISMA regla que los montos en UC de `matchCloseOf`. La única cuenta es
// la entrada más el aumento, y es una suma exacta de texto decimal: un `number` en el medio es la
// conversión que este archivo existe para no hacer.

/**
 * Lo que este asiento pagó y cobró en su moneda, o `undefined` si el precio no alcanza para decirlo —un
 * aumento aceptado a un nivel que el precio no cotizó—: ahí la fila del historial queda en UC, que es
 * lo que el jugador veía antes, en vez de mostrar un monto inventado.
 *
 * @param level el aumento aceptado (`MatchState.acceptedBetLevel`); 0 o 1 es la mesa sin aumento.
 * @param charged si el orquestador confirmó la entrada (sin eso nadie pagó nada).
 * @param paid si el resultado le asigna premio (`payoutOf`): el ganador que sigue siendo una persona.
 */
export function localMoneyOf(
  price: SeatPrice,
  level: number,
  facts: { readonly charged: boolean; readonly paid: boolean },
):
  | { readonly chargedInPlayerCurrency: string; readonly prizePaidInPlayerCurrency: string }
  | undefined {
  // EL AUMENTO MULTIPLICA LA MESA ENTERA, como en UC (`stakesOf`): el que subió a x3 pagó la entrada más
  // lo que costó subir, y el que ganó cobra el premio de x3 —no el de x1 más algo—.
  const raised = level >= 2 ? price.levels.find((option) => option.level === level) : undefined;
  if (level >= 2 && raised === undefined) return undefined;
  const entry = raised ? addDecimals(price.entry, raised.entry) : price.entry;
  const prize = raised ? raised.prize : price.prize;
  return {
    chargedInPlayerCurrency: facts.charged ? entry : zeroLike(price.entry),
    prizePaidInPlayerCurrency: facts.paid ? prize : zeroLike(price.prize),
  };
}

/** Un cero con los decimales del monto que reemplaza: `"200.00"` → `"0.00"`. */
export function zeroLike(amount: string): string {
  const fraction = amount.split(".")[1];
  return fraction === undefined ? "0" : `0.${"0".repeat(fraction.length)}`;
}

/**
 * La suma EXACTA de dos montos de texto decimal sin signo (`/^\d+(\.\d+)?$/`, lo que valida el contrato),
 * con los decimales del más largo: `"200.00" + "200.5"` es `"400.50"`. Con `bigint`, para que ningún
 * centavo pase por la mantisa de un `number`.
 */
export function addDecimals(left: string, right: string): string {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const scaled = (whole: string, fraction: string) => BigInt(whole + fraction.padEnd(scale, "0"));
  const digits = (scaled(leftWhole, leftFraction) + scaled(rightWhole, rightFraction))
    .toString()
    .padStart(scale + 1, "0");
  if (scale === 0) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
