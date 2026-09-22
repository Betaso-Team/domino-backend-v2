import type { Currency } from "./rates";

/**
 * A player's ACCOUNT in the main backend, as far as this feature cares. Three
 * pieces that come out of the same response, which is why they live in one port
 * and not three:
 *
 *   · the CURRENCY, to convert account units into cents;
 *   · the NAME and the PICTURE, which travel with the prize because the backend
 *     needs them for its winners carousel and does not have them to hand then.
 *
 * Asking for them separately would call the same endpoint twice for one player.
 */
export interface PlayerAccount {
  readonly currency: Currency;
  readonly username: string;
  readonly profilePicture: string;
}

/**
 * The `token` is THAT PLAYER's own credential, and it is optional because not
 * everyone who asks holds one. The backend answers against their token and not
 * against the server's API key: the question is "what is MY account?", not "what
 * is the account of this id?", which the truco has no business being able to ask
 * about anyone.
 *
 * Whoever holds it — matchmaking's door — passes it and leaves the answer cached.
 * Whoever does not — the charge, the prize, the rematch — finds it already
 * resolved, because the door always runs first.
 *
 * @throws {AccountUnavailableError} with no token and nothing cached, and when the
 * other side fails. Inventing a currency is charging wrong.
 */
export interface AccountDirectory {
  accountOf(playerId: string, token?: string): Promise<PlayerAccount>;
}

/**
 * The account could not be read. Sibling of `WalletUnavailableError`: a failure on
 * the other side and not a decision. Whoever receives it must treat it as "could
 * not", never as "has no balance" — confusing the two locks a player out over a
 * network hiccup.
 */
export class AccountUnavailableError extends Error {
  constructor(cause: string) {
    super(`no se pudo leer la cuenta: ${cause}`);
    this.name = "AccountUnavailableError";
  }
}
