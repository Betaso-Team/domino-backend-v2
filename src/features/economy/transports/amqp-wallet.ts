import { type AmqpDelivery, AmqpDeliveryError } from "@/shared/amqp";
import type { Ledger } from "../ledger";
import type { MatchAccounts } from "../match-accounts";
import type { MatchRates } from "../match-rates";
import { type Currency, toCents } from "../rates";
import { type Movement, WalletUnavailableError } from "../wallet";

// The ASYNCHRONOUS half of the money: what no longer decides anything — the prize and the refunds —
// and therefore only has to be DELIVERED. It goes over the queue because a delivery can be retried
// and a decision cannot. The retries are not from here: the outbox adds them, being what knows
// whether the movement was already written down.
//
// The queue's PLUMBING is not from here either: connection, confirms and the two ways to publish are
// shared with the tournament's participation report. What stays is the one thing this feature knows
// and its neighbour does not — the CONTRACT: which queue, which pattern and which fields.
//
// The backend consumes this in two different ways and both have to be respected:
//
//   movement       → a QUEUE, with the NestJS envelope, because an `@EventPattern` receives it and
//                    dispatches by that pattern.
//   room refund    → a topic EXCHANGE with a routing key, and the payload RAW, with no envelope.
//
// Mixing them is a message nobody consumes and a prize that never gets paid.

const MOVEMENTS_QUEUE = "transactions_queue";
const BETASO_EXCHANGE = "betaso";
const GAME_REFUND_KEY = "wallet.game.refund";

// The v2 contract's pattern: it says this sender no longer writes the carousel row itself, so the
// backend writes it. The older per-game pattern still exists on the other side for whoever did not
// migrate; we were born migrated.
const MOVEMENT_PATTERN = "game.movement.v2";

// What the backend calls each asynchronous movement. It is half of its idempotency key.
const ASYNC_REASON = {
  PRIZE: "win",
  REFUND: "refund",
  BET_MULTIPLIER_REFUND: "refund",
} as const;

type AsyncReason = keyof typeof ASYNC_REASON;

export interface AmqpWalletDeps {
  readonly publisher: AmqpDelivery;
  // The match's FROZEN account: the prize is paid in the currency the player entered with, and the
  // carousel names them as they were called when they played.
  readonly matchAccounts: MatchAccounts;
  readonly matchRates: MatchRates;
  // What the player actually put in comes from the LEDGER and not from a table: it is the sum of
  // what was charged to them. That makes the prize's stake exact even with a multiplier, and PER
  // PLAYER, which is what is right when each one is in their own currency.
  readonly ledger: Ledger;
}

// What a player STAKED in a match, in account units: the entry plus the multiplier's delta, counting
// only what was actually charged. The backend uses it for the multiple it shows in its ticker.
const WAGERED: readonly Movement["reason"][] = ["ENTRY_FEE", "BET_MULTIPLIER"];

export class AmqpWallet {
  constructor(private readonly deps: AmqpWalletDeps) {}

  /**
   * Credits the prize. It never throws over a balance — there is nothing to decide
   * — but it does throw over delivery.
   *
   * @throws {WalletUnavailableError} when the broker does not confirm the message.
   */
  async credit(movement: Movement): Promise<void> {
    // A prize of zero moves no money: publishing it would ask the backend to credit nothing, and at
    // a free table there would be no currency to read either, since nobody paid an entry.
    if (movement.amount <= 0) return;
    const { amount, currency, rate, account } = await this.convert(movement);
    await this.publishMovement({
      ...this.baseMovement(movement, amount, currency),
      reason: ASYNC_REASON.PRIZE,
      // The three fields that feed the front's carousel and ticker. `bet` is what was STAKED in
      // cents and not the prize: it is what the backend's multiple is computed from.
      username: account.username,
      profilePicture: account.profilePicture === "" ? null : account.profilePicture,
      bet: toCents(await this.wagered(movement.matchId, movement.playerId), rate),
    });
  }

  // What was really charged to that player in that match. SETTLED only: a charge that failed is not
  // a stake, and counting it would inflate the multiple the front shows.
  private async wagered(matchId: string, playerId: string): Promise<number> {
    return (await this.deps.ledger.entriesOf(matchId))
      .filter(
        (e) => e.playerId === playerId && e.status === "SETTLED" && WAGERED.includes(e.reason),
      )
      .reduce((total, e) => total + e.amount, 0);
  }

  /**
   * Returns ONE specific movement — today, the multiplier's delta that could not be
   * backed.
   *
   * @throws {WalletUnavailableError} when the broker does not confirm the message.
   */
  async refund(movement: Movement): Promise<void> {
    if (movement.amount <= 0) return;
    const { amount, currency } = await this.convert(movement);
    await this.publishMovement({
      ...this.baseMovement(movement, amount, currency),
      reason: ASYNC_REASON.REFUND,
    });
  }

  /**
   * Returns EVERYTHING charged in a match. It carries neither amounts nor
   * currencies: the other side reconstructs what it charged and reverses it, which
   * is what makes it idempotent there.
   *
   * @throws {WalletUnavailableError} when the broker does not confirm the message.
   */
  async refundMatch(matchId: string, playerIds: readonly string[]): Promise<void> {
    if (playerIds.length === 0) return;
    // RAW: this consumer is not an `@EventPattern`, so it carries no envelope.
    await this.deliver(() =>
      this.deps.publisher.publishTopic(BETASO_EXCHANGE, GAME_REFUND_KEY, {
        roomId: matchId,
        gameType: "domino",
        userIds: [...playerIds],
      }),
    );
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private baseMovement(movement: Movement, amount: number, currency: Currency) {
    return {
      userId: movement.playerId,
      amount,
      transactionType: "add",
      currency,
      walletType: "REAL",
      gameType: "domino",
      // The room identifier the backend deduplicates by and hangs the refund off.
      roomId: movement.matchId,
      gameMovementType: "domino",
    };
  }

  private async convert(movement: Movement) {
    const reason = movement.reason;
    if (!isAsyncReason(reason))
      throw new WalletUnavailableError(`${reason} no va por la cola: se cobra por HTTP`);
    const account = await this.deps.matchAccounts.accountOf(movement.matchId, movement.playerId);
    const rate = await this.deps.matchRates.rateFor(movement.matchId, account.currency);
    return { amount: toCents(movement.amount, rate), currency: account.currency, rate, account };
  }

  private async publishMovement(data: object): Promise<void> {
    await this.deliver(() =>
      this.deps.publisher.publishPattern(MOVEMENTS_QUEUE, MOVEMENT_PATTERN, data),
    );
  }

  // Translates the queue's error into this feature's vocabulary. The publisher knows nothing of
  // wallets — it cannot — and whoever receives this has no business learning a `shared/` error.
  private async deliver(publish: () => Promise<void>): Promise<void> {
    try {
      await publish();
    } catch (e) {
      if (e instanceof AmqpDeliveryError) throw new WalletUnavailableError(e.message);
      throw e;
    }
  }
}

function isAsyncReason(reason: Movement["reason"]): reason is AsyncReason {
  return reason === "PRIZE" || reason === "REFUND" || reason === "BET_MULTIPLIER_REFUND";
}
