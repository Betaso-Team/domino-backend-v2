import { type ApiKey, betasoBackendAuthHeaders } from "@/features/auth";
import { type HttpClient, HttpError } from "@/shared/http";
import type { AccountDirectory } from "../accounts";
import type { MatchAccounts } from "../match-accounts";
import type { MatchRates } from "../match-rates";
import { type Currency, type RateBook, toCents } from "../rates";
import {
  type AffordQuery,
  InsufficientFundsError,
  type Movement,
  WalletUnavailableError,
} from "../wallet";

// The SYNCHRONOUS half of the money: the two operations that DECIDE something and therefore have to
// be awaited. The other half only delivers and goes out on the queue.
//
// The asymmetry is not ours: the main backend charges over HTTP and credits over the broker. It makes
// sense — when charging, whether it covered it has to be known before letting anyone play; when
// paying there is nothing to decide, the prize is already won.

// What the backend calls each charge. It is half of its idempotency key, so it has to match the one
// v1 already uses or the two charges would not be recognised as the same.
const CHARGE_REASON = {
  ENTRY_FEE: "entry_fee",
  BET_MULTIPLIER: "bet_multiplier",
} as const;

type ChargeableReason = keyof typeof CHARGE_REASON;

export interface HttpWalletDeps {
  readonly http: HttpClient;
  readonly apiKey: ApiKey;
  // The LIVE account, for the door: there is no match there to freeze anything to, and whoever asks
  // carries their token.
  readonly accounts: AccountDirectory;
  // The FROZEN one, for everything that happens with a match already open. It is what guarantees the
  // charge and the payout share one currency: the one the player held on the way in.
  readonly matchAccounts: MatchAccounts;
  // The LIVE rate, for the door.
  readonly rates: RateBook;
  // The FROZEN one, for the charges: the entry and the multiplier of one match have to be converted
  // at the same rate that later pays the prize.
  readonly matchRates: MatchRates;
}

export class HttpWallet {
  constructor(private readonly deps: HttpWalletDeps) {}

  /**
   * Can they afford it? At the LIVE rate and this instant's balance. A snapshot and
   * not a hold: between this answer and the charge the balance can change, so what
   * really decides is still the charge. It exists so the rival is not dragged into
   * a match that is going to collapse.
   */
  async canAfford({ playerId, amount, token, matchId }: AffordQuery): Promise<boolean> {
    // From the door it is asked with the token; from a match already open, with its id — and there
    // the currency has to be the frozen one, or the rematch would compare the balance against a
    // currency the match is not being played in.
    const { currency } = matchId
      ? await this.deps.matchAccounts.accountOf(matchId, playerId)
      : await this.deps.accounts.accountOf(playerId, token);
    const rate = await this.deps.rates.rateFor(currency);
    const balance = await this.balanceOf(playerId, currency);
    return balance >= toCents(amount, rate);
  }

  /**
   * Charges.
   *
   * @throws {InsufficientFundsError} when the balance does not cover it — an
   * answer, not a failure.
   * @throws {WalletUnavailableError} when the other side did not answer.
   */
  async charge(movement: Movement): Promise<void> {
    const reason = movement.reason;
    if (!isChargeable(reason))
      throw new WalletUnavailableError(`${reason} no se cobra por HTTP: va por la cola`);

    const { currency } = await this.deps.matchAccounts.accountOf(
      movement.matchId,
      movement.playerId,
    );
    const rate = await this.deps.matchRates.rateFor(movement.matchId, currency);

    try {
      // No headers: this endpoint of the backend asks for none. That it does not is their problem,
      // and sending extra ones fixes nothing.
      await this.deps.http.post("wallet-movements/betaso-game-movement", {
        userId: movement.playerId,
        amount: toCents(movement.amount, rate),
        transactionType: "cut",
        // The room identifier the backend deduplicates by. Here it is the `matchId`, which is the
        // room id — stable and unique, which is all that is needed.
        tokenId: movement.matchId,
        currency,
        gameMovementType: "domino",
        reason: CHARGE_REASON[reason],
      });
    } catch (e) {
      // A 400 is how this endpoint says "they cannot afford it": an ANSWER, and whoever charges
      // decides what to do with it. Anything else means it could not be asked, and that one can be
      // retried further up.
      if (e instanceof HttpError && e.status === 400)
        throw new InsufficientFundsError(movement.playerId);
      throw new WalletUnavailableError(`cobro de ${movement.playerId}: ${String(e)}`);
    }
  }

  // The balance in CENTS of that currency: the endpoint returns a bare number, not an object.
  private async balanceOf(playerId: string, currency: Currency): Promise<number> {
    const query = `currency=${encodeURIComponent(currency)}&userId=${encodeURIComponent(playerId)}`;
    try {
      const balance = await this.deps.http.get<number>(
        `wallets/my-balance-microservice?${query}`,
        betasoBackendAuthHeaders(this.deps.apiKey),
      );
      // A balance that is not a number is an answer we do not understand, and treating it as zero
      // would lock the player out over a contract change on the other side.
      if (typeof balance !== "number" || !Number.isFinite(balance))
        throw new Error(`saldo no numérico: ${String(balance)}`);
      return balance;
    } catch (e) {
      throw new WalletUnavailableError(`saldo de ${playerId}: ${String(e)}`);
    }
  }
}

function isChargeable(reason: Movement["reason"]): reason is ChargeableReason {
  return reason === "ENTRY_FEE" || reason === "BET_MULTIPLIER";
}
