// COPIA de `packages/money/src/pricing.ts` de tablea-gaming-orchestrator, commit 85cd1a4. Se copia
// ENTERA y TAL CUAL, salvo el formato que pide biome; `pricing.vectors.json` es la misma del monorepo y
// la corre `tests/pricing.test.ts`. Un cambio se hace allá primero y se vuelve a copiar.

import { type Decimal, count, roundHalfUp } from "./decimal";

// THE FORMULAS OF A TABLE'S MONEY, written once and used by every service that computes them: billing
// (which charges and pays), the orchestrator (which checks what the game reports) and domino (which
// shows it and reports it). The same input gives the same decimal everywhere, so a comparison between
// two services is an exact equality and never a tolerance.
//
// The rule (domino v1's, kept by billing): at bet level L the WHOLE table is multiplied by L. The entry
// fee and the prize at level L are `base × L`, and accepting a bet to L owes the difference with the
// level before it, `base × (L − 1)` over the level-1 price.
//
// Copied verbatim into domino-backend-v2 (`src/shared/money/pricing.ts`); `pricing.vectors.json` runs
// in both repos.

/** What an amount of the table (`entryFee`, `prize`) is worth at bet level `level` (1 = no bet). */
export function stakeAt(base: Decimal, level: number): Decimal {
  if (!Number.isSafeInteger(level) || level < 1) throw new Error(`nivel inválido: ${level}`);
  return base.times(count(level));
}

/**
 * What accepting a bet to `level` adds over the level-1 price: `base × (level − 1)`. Level 1 adds
 * nothing.
 */
export function betDifference(base: Decimal, level: number): Decimal {
  if (!Number.isSafeInteger(level) || level < 1) throw new Error(`nivel inválido: ${level}`);
  return base.times(count(level - 1));
}

/**
 * An amount in UC in a currency: `round(amountUc × rate)`, half up, once, to the currency's decimals.
 * `rate` is what 1 UC is worth in that currency.
 */
export function toCurrency(amountUc: Decimal, rate: Decimal, decimals: number): Decimal {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error(`decimales inválidos: ${decimals}`);
  }
  return roundHalfUp(amountUc.times(rate), decimals);
}
