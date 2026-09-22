import type { Movement, MovementReason } from "./wallet";

// OUR OWN LEDGER: idempotency control and local traceability. It is NOT the source of truth for a
// balance — that belongs to the main backend — it is what keeps the same thing from being charged
// twice.
//
// The key is `(match, player, reason)`, the same one the other side deduplicates by. Its practical
// consequence runs both ways and is worth keeping in mind: retrying the same charge is safe, but TWO
// legitimate movements cannot share that tuple either. That is why charging the multiplier has a
// reason of its own and is not another entry fee.

export type MovementStatus = "PENDING" | "SETTLED" | "FAILED";

export interface LedgerEntry extends Movement {
  status: MovementStatus;
  /**
   * When it was written. Not decoration: it is what lets an expiry know what to
   * delete, and what allows a match-id COLLISION to be recognised — a key repeated
   * days later is not a duplicate, it is another match that landed on the same id
   * — instead of silently letting someone play for free.
   */
  readonly createdAt: number;
  /**
   * WHY SOMEONE HAS TO LOOK. A separate axis and not a fourth status, and that
   * separation matters: `status` says what happened to the money and code decides
   * with it, so slipping a new value in would silently change money arithmetic.
   */
  review?: LedgerReview;
}

export interface LedgerReview {
  /**
   * `INTERRUPTED` — left `PENDING` and the process restarted: it is NOT KNOWN
   *                 whether the charge landed, and that has to be found out before
   *                 touching anything.
   * `UNDELIVERED`  — left `FAILED` after exhausting the retries: it did not land,
   *                 and redoing it is safe.
   */
  readonly reason: "INTERRUPTED" | "UNDELIVERED";
  /**
   * The status it was found in. It is what tells the two cases above apart, and it
   * is stored even though `status` is right there: the mark has to be readable on
   * its own.
   */
  readonly statusAtMark: MovementStatus;
  readonly markedAt: number;
  readonly detail?: string;
}

/**
 * A movement that already exists was registered again. This is what makes a retry
 * safe: whoever catches it knows the effect is already recorded and must not ask
 * for it again.
 */
export class DuplicateMovementError extends Error {
  constructor(readonly key: string) {
    super(`movimiento duplicado: ${key}`);
    this.name = "DuplicateMovementError";
  }
}

/** The key, in one place: both implementations and the database's unique index share it. */
export const keyOf = (matchId: string, playerId: string, reason: MovementReason) =>
  `${matchId}:${playerId}:${reason}`;

/**
 * THE PORT. Every operation is ASYNCHRONOUS because the ledger is durable: what is
 * written has to be on disk before the money moves, and that is its whole reason
 * to exist. Where nobody can await — a listener, synchronous by contract — the
 * write is released with its own `catch` and it SHOWS that it is in flight,
 * instead of being hidden behind a method that looks immediate.
 */
export interface Ledger {
  /**
   * Writes the movement down as PENDING. Registering is reserving the key, and
   * reserving it BEFORE the money moves is what prevents the double charge: writing
   * it afterwards leaves a crash in between with the charge made and no trace.
   *
   * @throws {DuplicateMovementError} when the key already exists.
   */
  reserve(movement: Movement): Promise<LedgerEntry>;
  settle(movement: Movement): Promise<void>;
  /**
   * Marking it failed — rather than deleting it — is what leaves the trail for
   * reconciliation: a movement that never landed is visible, instead of vanishing
   * as if it had never been attempted.
   */
  fail(movement: Movement): Promise<void>;
  has(matchId: string, playerId: string, reason: MovementReason): Promise<boolean>;
  /**
   * How a movement ended up. What whoever settles consults to know what was really
   * charged — the difference between what was agreed and what was taken.
   *
   * @returns `undefined` when it was never asked for.
   */
  statusOf(
    matchId: string,
    playerId: string,
    reason: MovementReason,
  ): Promise<MovementStatus | undefined>;
  entriesOf(matchId: string): Promise<readonly LedgerEntry[]>;
}
