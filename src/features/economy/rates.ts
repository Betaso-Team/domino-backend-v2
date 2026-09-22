// UNIT CONVERSION, which is what separates this feature from the real world.
//
// The wallet port speaks the game mode's abstract ACCOUNT UNIT; the main backend charges in CENTS of
// the player's currency. Translating between them is the transport's job, and these are the two
// pieces it needs to do it.
//
// They live in `economy` and not in `match` on purpose: the engine does not know currencies exist,
// and that ignorance is what keeps it foldable into another game.

/**
 * The three currencies a player can hold a balance in. It matches the main
 * backend's enum, which is what rules: a union and not an enum here because
 * nothing is instantiated, only compared and sent over the wire.
 */
export type Currency = "USD" | "VES" | "USDT";

export const CURRENCIES: readonly Currency[] = ["USD", "VES", "USDT"];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/**
 * What one account unit is worth in a currency. The backend serves it per currency
 * and without an id, so there is no id here either.
 */
export interface RateBook {
  rateFor(currency: Currency): Promise<number>;
}

/**
 * From account units to CENTS of the player's currency, which is the only thing
 * the main backend understands. It lives here because it is THE translation
 * between the two vocabularies: the catalog's and the money's.
 */
export function toCents(amount: number, rate: number): number {
  return Math.round(amount * rate * 100);
}

/**
 * The rate could not be read. Sibling of `WalletUnavailableError` and
 * `AccountUnavailableError`: a failure on the other side and not a decision.
 */
export class ConversionUnavailableError extends Error {
  constructor(cause: string) {
    super(`no se pudo convertir: ${cause}`);
    this.name = "ConversionUnavailableError";
  }
}
