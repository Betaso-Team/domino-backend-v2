// COPIA de `packages/money/src/money.ts` de tablea-gaming-orchestrator, commit 8e9732e. Se copia TAL
// CUAL (docs/convenciones/montos.md, «Fuera del monorepo»): solo cambia el formato que pide biome. Un
// cambio a la regla se hace allá primero y se vuelve a copiar, junto con `money.vectors.json`, que
// corre `money.test.ts`.
//
// THE AMOUNTS A SERVICE EMITS: an object with one key per currency, lowercase, and the amount as a
// decimal string: `{ ves: '1000.00', uc: '10.0000' }`. The real currency always; `uc` only when the
// record keeps the rate of its moment. Never a bare number nor a sibling `currency`. The full rule is
// `docs/convenciones/montos.md` in the tablea-gaming-orchestrator monorepo.
//
// This file has no dependencies and is copied verbatim into repos outside the monorepo
// (domino-backend-v2, `src/shared/money.ts`, with the source commit in its header). The arithmetic is
// exact: `bigint` over the decimal text; a JS `number` never carries an amount.

/** An amount in the convention: lowercase currency → decimal string. */
export type Money = Readonly<Record<string, string>>;

/** The decimals of an amount in UC: those of billing's `amount_uc` (`numeric(20,4)`). */
export const UC_DECIMALS = 4;

/** The key of the unit of account in a `Money`. */
export const UC_KEY = "uc";

/** A decimal with an optional sign: `-12.5`, `0`, `1000.00`. No exponent, no leading zeros. */
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** A currency code: `VES`, `USD`, `USDT`, `UC`. */
const CURRENCY = /^[A-Za-z][A-Za-z0-9]*$/;

// The places big.js divides to (`Big.DP`, 20 by default) before billing rounds: `toUc` repeats that
// first rounding so its last digit is billing's.
const BIG_JS_DIVISION_PLACES = 20;

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

function parse(text: unknown, what = "el monto"): Parsed {
  if (typeof text !== "string" || !DECIMAL.test(text)) {
    throw new MoneyError(`${what} no es un decimal en texto: ${JSON.stringify(text)}`);
  }
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

function currencyKey(currency: unknown): string {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) {
    throw new MoneyError(`no es un código de moneda: ${JSON.stringify(currency)}`);
  }
  return currency.toLowerCase();
}

/** The amount as a scaled integer: `'-1.5'` at scale 2 is `-150n`. The scale never drops digits. */
function scaled(value: Parsed, scale: number): bigint {
  const digits = BigInt(value.whole + value.fraction.padEnd(scale, "0"));
  return value.negative ? -digits : digits;
}

/** The scaled integer as text with exactly `scale` decimals; zero never carries a sign. */
function format(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** `n ÷ d` (d > 0) rounded half-up to an integer, away from zero on a tie: big.js's `roundHalfUp`. */
function divideHalfUp(n: bigint, d: bigint): bigint {
  const magnitude = n < 0n ? -n : n;
  const quotient = magnitude / d;
  const rounded = 2n * (magnitude % d) >= d ? quotient + 1n : quotient;
  return n < 0n ? -rounded : rounded;
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
  return format(scaled(value, scale), scale);
}

/**
 * An amount in the convention: `{ <currency>: amount }` with the currency's decimals and, when given,
 * `uc` with 4. When the currency is UC (any case) it is `{ uc: amount }` alone; there a `uc` worth
 * something else than `amount` is an error, never ignored.
 * @param decimals the currency's (billing's currency catalog); unused for UC.
 * @throws {MoneyError}
 */
export function money(currency: string, amount: string, decimals: number, uc?: string): Money {
  const key = currencyKey(currency);
  if (key === UC_KEY) {
    const value = fixed(amount, UC_DECIMALS);
    if (uc !== undefined && !sameAmount(value, uc)) {
      throw new MoneyError(`un monto en UC con otro uc: ${amount} y ${uc}`);
    }
    return Object.freeze({ [UC_KEY]: value });
  }
  const value = fixed(amount, decimals);
  if (uc === undefined) return Object.freeze({ [key]: value });
  return Object.freeze({ [key]: value, [UC_KEY]: fixed(uc, UC_DECIMALS) });
}

/** An amount that only exists in UC (the catalog, the debt cap): `{ uc: amount }` with 4 decimals. */
export function ucOnly(amount: string): Money {
  return money("UC", amount, UC_DECIMALS);
}

/**
 * `amount` (in a currency) in UC with `rate` (what 1 UC is worth in that currency), rounded half-up to
 * 4 decimals. It is billing's rule, `roundHalfUp(convert(amount, currency, 'UC', rates), 4)` (`capInUc`
 * in `apps/billing-auth/src/billing/features/network-settings/domain/debt-settings.ts`): big.js divides
 * to 20 places half-up, then the result is rounded half-up to 4. Both steps are repeated here, so even
 * the tie the first one creates matches (`0.000049999999999999999995` → `0.0001`).
 * @throws {MoneyError} when an argument is not a decimal or the rate is not greater than zero.
 */
export function toUc(amount: string, rate: string): string {
  const value = parse(amount);
  const by = parse(rate, "la tasa");
  const divisor = scaled(by, by.fraction.length);
  if (by.negative || divisor === 0n) {
    throw new MoneyError(`la tasa tiene que ser mayor que cero: ${rate}`);
  }
  // amount ÷ rate = (A / 10^sa) ÷ (R / 10^sr) = A·10^sr ÷ (R·10^sa), scaled by 10^20 for the first step.
  const numerator = scaled(value, value.fraction.length) * 10n ** BigInt(by.fraction.length);
  const denominator = divisor * 10n ** BigInt(value.fraction.length);
  const atBigJsPlaces = divideHalfUp(
    numerator * 10n ** BigInt(BIG_JS_DIVISION_PLACES),
    denominator,
  );
  const inUc = divideHalfUp(atBigJsPlaces, 10n ** BigInt(BIG_JS_DIVISION_PLACES - UC_DECIMALS));
  return format(inUc, UC_DECIMALS);
}

/** Whether two decimal strings are worth the same (`'10'` and `'10.0000'` are). */
export function sameAmount(left: string, right: string): boolean {
  const a = parse(left);
  const b = parse(right);
  const scale = Math.max(a.fraction.length, b.fraction.length);
  return scaled(a, scale) === scaled(b, scale);
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
 * THE TOLERANT READER, for what comes from an emitter that may be in the old shape or the new one (a
 * message in an outbox or a DLQ, a service not yet deployed). It accepts:
 *  - a decimal string (`'1000.00'`), as is;
 *  - a finite `number` (`10.5`), in its shortest decimal form;
 *  - a `Money` (`{ ves: '1000.00', uc: '10.0000' }`): the amount under `currency` lowercased (`uc`
 *    for UC).
 * Returns the decimal string. It goes away once no emitter or queue holds the old shape.
 * @throws {MoneyError} when it is none of the three, or the `Money` lacks the key.
 */
export function readAmount(value: unknown, currency: string): string {
  const key = currencyKey(currency);
  if (typeof value === "string") {
    parse(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyError(`el monto no es finito: ${value}`);
    return numberText(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const amount = (value as Record<string, unknown>)[key];
    if (amount === undefined) {
      throw new MoneyError(`el monto no trae la llave ${key}: ${JSON.stringify(value)}`);
    }
    parse(amount, `el monto en ${key}`);
    return amount as string;
  }
  throw new MoneyError(
    `el monto no es un decimal en texto, un número ni un objeto por moneda: ${JSON.stringify(value)}`,
  );
}
