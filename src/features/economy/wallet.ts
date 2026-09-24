// The PORT towards the money: what this feature needs of the world. Who implements it is none of its
// business.
//
// `economy` imports nothing from `match`: ids travel as primitive strings and amounts in the game
// mode's abstract ACCOUNT UNIT, not in cents. Converting to a player's currency at their rate is the
// transport's job.

/**
 * Why the money moved. Together with the match and the player it is the
 * idempotency key: a new charging concept is added here as one more reason and not
 * as a loose field.
 */
export type MovementReason =
  | "ENTRY_FEE"
  | "BET_MULTIPLIER"
  | "PRIZE"
  /** Returning EVERYTHING charged in a match that never got played. */
  | "REFUND"
  /**
   * Returning ONLY the multiplier's delta, when a scaled bet could not be backed.
   * It has a reason of its own and deliberately does not reuse `REFUND`: the
   * reason is part of the idempotency key, so sharing it would have a multiplier
   * rollback CONSUME the slot of the room's later refund.
   */
  | "BET_MULTIPLIER_REFUND";

export interface Movement {
  readonly matchId: string;
  readonly playerId: string;
  readonly amount: number;
  readonly reason: MovementReason;
}

/**
 * Not enough balance. An EXPECTED refusal and not a failure: whoever charges
 * decides what to do about it. It extends no match error type because this feature
 * does not know `match`.
 */
export class InsufficientFundsError extends Error {
  constructor(readonly playerId: string) {
    super(`saldo insuficiente: ${playerId}`);
    this.name = "InsufficientFundsError";
  }
}

/**
 * The movement could not be executed because of a failure on the other side.
 * Unlike the previous one this one IS retried: the balance was there.
 */
export class WalletUnavailableError extends Error {
  constructor(cause: string) {
    super(`wallet no disponible: ${cause}`);
    this.name = "WalletUnavailableError";
  }
}

/**
 * The balance question. An object and not three positionals because the last
 * two fields are MUTUALLY EXCLUSIVE — one or the other, depending on who is
 * asking — and that does not show in a parameter list.
 */
export interface AffordQuery {
  readonly playerId: string;
  readonly amount: number;
  readonly token?: string;
  readonly matchId?: string;
}

export interface WalletPort {
  /**
   * Can they afford it? A QUERY and not a hold: between this answer and the charge
   * the balance can change, so the charge is still what decides. It exists so
   * someone can be refused at the DOOR — before being queued — and not after being
   * paired: bouncing them at admission takes the rival's match down with it.
   *
   * It carries ONE of the two ways of knowing which currency this player is
   * charged in, and which of the two says where the question comes from:
   *
   *   · `token`   — the DOOR. The first to ask and the only one holding the
   *                 player's credential; there is no match to freeze anything to.
   *   · `matchId` — everything AFTERWARDS, which reads that match's already frozen
   *                 account and therefore needs no credential.
   *
   * This is all this port knows about credentials: it does not interpret them, it
   * passes them on.
   */
  canAfford(query: AffordQuery): Promise<boolean>;
  /**
   * AWAITED by nature: whether they can pay has to be known before they are let in
   * to play.
   *
   * @throws {InsufficientFundsError} when the balance does not cover it.
   * @throws {WalletUnavailableError} when the other side failed.
   */
  charge(movement: Movement): Promise<void>;
  /**
   * Crediting decides nothing — the prize is already won — so it never throws over
   * a balance. It goes through the outbox precisely because its only possible
   * failure is one of delivery.
   */
  credit(movement: Movement): Promise<void>;
  /**
   * Returns ONE specific movement. Needed for the multiplier's delta: when a
   * scaled bet cannot be backed, exactly that has to go back to whoever did pay it.
   */
  refund(movement: Movement): Promise<void>;
  /**
   * Returns EVERYTHING charged in a match. The truco names neither amounts nor
   * wallets: the other side reconstructs what it charged and reverses it, which is
   * what makes it idempotent there.
   */
  refundMatch(matchId: string, playerIds: readonly string[]): Promise<void>;
}
