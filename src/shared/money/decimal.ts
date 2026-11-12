// COPIA de `packages/money/src/decimal.ts` de tablea-gaming-orchestrator, commit 85cd1a4. Se copia
// ENTERA y TAL CUAL, salvo el formato que pide biome, con `big.js` en la misma versión exacta (7.0.1).
// Un cambio se hace allá primero y se vuelve a copiar, junto con `pricing.vectors.json`.

import Big from "big.js";

// THE DECIMAL OF THE MONEY, the one type every service computes an amount with: rates and amounts are
// exact decimals with no limit on the digits before or after the point. In Postgres they are `numeric`
// (read as text), in JSON a decimal string, and here a big.js number. A JS `number` never carries one:
// it is binary floating point (`0.02 + 0.02 × 5` is `0.12000000000000001`).
//
// Copied verbatim into domino-backend-v2 (`src/shared/money/decimal.ts`) with `big.js` at the same
// version; a change here is copied there with `pricing.vectors.json`.

/** Our own big.js constructor, so its settings never leak into (or from) anyone else's. */
export const Decimal = Big();
// Building one from a JS number throws: a value that already went through floating point is refused.
Decimal.strict = true;
// `toString()` never switches to exponential notation (big.js does below 1e-7 by default): `0.00000105`
// stays `0.00000105`, which is what Postgres and the JSON contracts expect.
Decimal.NE = -1_000_000;
Decimal.PE = 1_000_000;

export type Decimal = Big.Big;

/** The text of a non-negative decimal: digits, and optionally a point and more digits. */
export const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

// Strict mode refuses a number anywhere, comparisons included: compare against these.
export const ZERO = new Decimal("0");
export const ONE = new Decimal("1");

/** @throws {Error} when the text is not a plain non-negative decimal. */
export function decimal(text: string): Decimal {
  if (typeof text !== "string" || !DECIMAL_TEXT.test(text)) {
    throw new Error(`no es un decimal: ${String(text)}`);
  }
  return new Decimal(text);
}

/**
 * A number that is already in a record as a JS number (an older order's `rate`, an amount an older
 * emitter sent as a number), through its shortest decimal form: `95.1` is read as `95.1`, not as the
 * binary float closest to it. Only for reading the past: nothing new is computed in `number`.
 */
export function fromNumber(value: number): Decimal {
  if (!Number.isFinite(value) || value < 0) throw new Error(`no es un decimal: ${value}`);
  return new Decimal(String(value));
}

/** An integer count (seats, a bet level) as a decimal, to multiply an amount by it. */
export function count(value: number): Decimal {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`no es un entero no negativo: ${value}`);
  }
  return new Decimal(String(value));
}

/** Rounds half up to `places` decimals: the only rounding the money ever does. */
export function roundHalfUp(value: Decimal, places: number): Decimal {
  return value.round(places, Big.roundHalfUp);
}
