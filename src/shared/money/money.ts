// COPIA de `packages/money/src/money.ts` de tablea-gaming-orchestrator, commit 85cd1a4 (la convención
// v2 sobre el `Decimal`). Se copia TAL CUAL (docs/convenciones/montos.md, «Fuera del monorepo»), salvo
// dos cosas: el formato que pide biome, y que queda afuera lo que el dominó no usa —`isReservedCode` (el
// catálogo de monedas es de billing) y lo `@deprecated` de v1 (`money`, `ucOnly`, `toUc`, `Money`,
// `UC_KEY`, y `currencyKey`, que sólo lo usaba `money`)—. Un cambio a la regla se hace allá primero y se
// vuelve a copiar, junto con `money.vectors.json` (sin los grupos de lo que no se copió), que corre
// `tests/money.test.ts`.

import { Decimal } from "./decimal";

// THE AMOUNTS A SERVICE EMITS (v2): every entity carries one `currency` and all of its amounts are in
// it, each one a plain decimal string padded to that currency's decimals and never rounded:
// `{ currency: 'VES', entryFee: '10.00', guaranteedPrize: '0.00' }`. No `uc` key: a record charged
// with a rate exposes its `rateId`, and an amount born in UC is an entity with `currency: 'UC'`. The
// code is billing's, as is (`VES`), and `UC` is reserved. The full rule is
// `docs/convenciones/montos.md` in the tablea-gaming-orchestrator monorepo.
//
// This file is copied verbatim into repos outside the monorepo (domino-backend-v2,
// `src/shared/money/money.ts`, with the source commit in its header), together with `decimal.ts`. The
// arithmetic is billing's `Decimal` (big.js): a JS `number` never carries an amount.

/** The unit of account of the network, exactly as it travels in a `currency` field. */
export const UC = "UC";

/** The decimals of an amount in UC: those of billing's `amount_uc` (`numeric(20,4)`). */
export const UC_DECIMALS = 4;

/** A decimal with an optional sign: `-12.5`, `0`, `1000.00`. No exponent, no leading zeros. */
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** A currency code: `VES`, `USD`, `USDT`, `UC`. */
const CURRENCY = /^[A-Za-z][A-Za-z0-9]*$/;

/** An amount or an argument outside the convention. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

interface Parsed {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
}

/**
 * Whether `value` is a strict decimal string: an optional `-`, no exponent, no `+`, no leading zeros
 * and no bare point (`'-12.5'`, `'0'`, `'1000.00'`; never `'1e5'`, `'01'`, `'.5'`, `'1.'`). A `number`
 * is never one.
 */
export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

/**
 * Asserts `isDecimal(value)`.
 * @param what how the message names the value (`'el monto'` by default).
 * @throws {MoneyError} when it is not a strict decimal string.
 */
export function assertDecimal(value: unknown, what = "el monto"): asserts value is string {
  if (!isDecimal(value)) {
    throw new MoneyError(`${what} no es un decimal en texto: ${JSON.stringify(value)}`);
  }
}

function parse(text: unknown, what = "el monto"): Parsed {
  assertDecimal(text, what);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  return { negative, whole, fraction };
}

function places(decimals: unknown): number {
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    throw new MoneyError(`decimals tiene que ser un entero no negativo: ${String(decimals)}`);
  }
  return decimals;
}

function currencyCode(currency: unknown): string {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    throw new MoneyError(`no es un código de moneda: ${JSON.stringify(currency)}`);
  }
  return currency;
}

/** The decimal of a text the convention accepts (sign included). */
function signed(text: string): Decimal {
  return new Decimal(text);
}

/**
 * The amount with at least `decimals` decimals: pads with zeros and NEVER drops a digit. A text with
 * more decimals than `decimals` keeps them: a response never rounds. Negative zero (`-0.0`) comes out
 * unsigned.
 * @throws {MoneyError} when the text is not a decimal or `decimals` is not a non-negative integer.
 */
export function fixed(text: string, decimals: number): string {
  const value = parse(text);
  const scale = Math.max(places(decimals), value.fraction.length);
  // big.js never prints a sign on zero, and `toFixed` at a scale ≥ the text's never drops a digit.
  return signed(text).toFixed(scale);
}

/** Whether two decimal strings are worth the same (`'10'` and `'10.0000'` are). */
export function sameAmount(left: string, right: string): boolean {
  parse(left);
  parse(right);
  return signed(left).eq(signed(right));
}

/** A finite `number` in its shortest decimal form, without exponent: `1.5e-7` → `'0.00000015'`. */
function numberText(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  let plain: string;
  if (point <= 0) plain = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + "0".repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + plain;
}

/**
 * THE TOLERANT READER, for what comes from an emitter that may be in an older shape or in v2 (a message
 * in an outbox or a DLQ, a service not yet deployed). It accepts:
 *  - a decimal string (`'1000.00'`), as is: v2, with `currency` taken from the entity;
 *  - a finite `number` (`10.5`), in its shortest decimal form: the shape before v1;
 *  - a v1 `Money` (`{ ves: '1000.00', uc: '10.0000' }`): the amount under `currency` as is or
 *    lowercased (`{ VES }` or `{ ves }`; `{ UC }` or `{ uc }` for UC). Both cases with different
 *    amounts are ambiguous and refused.
 * Returns the decimal string. It goes away once no emitter or queue holds an older shape.
 * @throws {MoneyError} when it is none of the three, or the `Money` lacks the key.
 */
export function readAmount(value: unknown, currency: string): string {
  const code = currencyCode(currency);
  if (typeof value === "string") {
    assertDecimal(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyError(`el monto no es finito: ${value}`);
    return numberText(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const keys = [...new Set([code, code.toLowerCase(), code.toUpperCase()])].filter(
      (key) => object[key] !== undefined,
    );
    const [key] = keys;
    if (key === undefined) {
      throw new MoneyError(`el monto no trae la llave ${code}: ${JSON.stringify(value)}`);
    }
    const amounts = keys.map((k) => object[k]);
    amounts.forEach((amount, i) => assertDecimal(amount, `el monto en ${keys[i]}`));
    const amount = amounts[0] as string;
    if (!amounts.every((other) => sameAmount(amount, other as string))) {
      throw new MoneyError(`el monto trae ${code} con dos valores: ${JSON.stringify(value)}`);
    }
    return amount;
  }
  throw new MoneyError(
    `el monto no es un decimal en texto, un número ni un objeto por moneda: ${JSON.stringify(value)}`,
  );
}
