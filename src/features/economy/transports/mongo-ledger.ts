import { ENGINE_VERSION, type Mongo } from "@/shared/mongo";
import {
  DuplicateMovementError,
  type Ledger,
  type LedgerEntry,
  type LedgerReview,
  type MovementStatus,
  keyOf,
} from "../ledger";
import type { Movement, MovementReason } from "../wallet";

// THE LEDGER, in the collection v1 already uses for the same thing. It shares the collection, which
// is why it carries `version`: the one thing that tells our row from theirs.
//
// v1's fields are respected as-is because its unique index lives in the database and applies to our
// rows as much as to theirs. Ours are added on top: `status`, `review` and `version`, which v1 does
// not know and Mongo does not make it miss.
//
// **The amount is in ACCOUNT UNITS** and not in cents: that is what the ledger knows. The currency
// and the rate it was converted at are in the row the main backend wrote on its side, findable by the
// same room id — and they are not duplicated here because nobody needs them: a `PENDING` is not
// retried on its own.
interface MovementDocument {
  readonly _id: string;
  readonly roomId: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly amount: number;
  readonly reason: MovementReason;
  status: MovementStatus;
  review?: LedgerReview;
  readonly version: number;
  readonly createdAt: Date;
  updatedAt: Date;
  /**
   * WHEN IT GETS DELETED. Only the rows that expire carry it: Mongo does not delete
   * what lacks this field, and that is exactly the mechanism by which "fifteen
   * days, except what someone has to look at" is expressed in an index — a TTL
   * admits no condition, but an absent field does.
   */
  expiresAt?: Date;
}

// Fifteen days: how long it takes to stop being useful. What does NOT expire is what went wrong — a
// `FAILED`, a flagged row — which is kept until a person resolves it.
const RETENTION_DAYS = 15;

export class MongoLedger implements Ledger {
  constructor(
    private readonly mongo: Mongo,
    private readonly collectionName: string,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(movement: Movement): Promise<LedgerEntry> {
    const key = keyOf(movement.matchId, movement.playerId, movement.reason);
    const at = new Date(this.now());
    try {
      // The `_id` IS the idempotency key, so the duplicate is rejected by the DATABASE and not by a
      // check of ours: between read and write there is no gap for a second charge to slip through.
      await (await this.collection()).insertOne({
        _id: key,
        roomId: movement.matchId,
        // v1 tells the two apart; for us they are the same match identifier, and that is how it
        // travels to the main backend.
        tokenId: movement.matchId,
        userId: movement.playerId,
        amount: movement.amount,
        reason: movement.reason,
        status: "PENDING",
        version: ENGINE_VERSION,
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(at.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
      });
    } catch (e) {
      if (isDuplicate(e)) throw new DuplicateMovementError(key);
      throw e;
    }
    return { ...movement, status: "PENDING", createdAt: at.getTime() };
  }

  async settle(movement: Movement): Promise<void> {
    await this.mark(movement, "SETTLED");
  }

  // A failed movement stops expiring: it is precisely the one someone will have to look at, and
  // deleting it after fifteen days would lose the only trace that something had to be returned.
  async fail(movement: Movement): Promise<void> {
    await this.mark(movement, "FAILED", true);
  }

  async has(matchId: string, playerId: string, reason: MovementReason): Promise<boolean> {
    return (await this.statusOf(matchId, playerId, reason)) !== undefined;
  }

  async statusOf(
    matchId: string,
    playerId: string,
    reason: MovementReason,
  ): Promise<MovementStatus | undefined> {
    const document = await (await this.collection()).findOne({
      _id: keyOf(matchId, playerId, reason),
    });
    return document?.status;
  }

  async entriesOf(matchId: string): Promise<readonly LedgerEntry[]> {
    // By room and not by the `_id` prefix: that is the field v1 has indexed.
    const documents = await (await this.collection()).find({ roomId: matchId }).toArray();
    return documents.map(toEntry);
  }

  /**
   * WHAT WAS LEFT HALF-DONE, flagged for someone to look at. It runs at startup and
   * is the only thing startup does with money: **nothing is retried**. A `PENDING`
   * is ambiguous — the charge may have landed and the response been lost — and the
   * main backend does not deduplicate, so retrying would charge twice. A `FAILED`
   * is known not to have landed; it is flagged all the same so it is visible.
   *
   * @returns how many rows were flagged.
   */
  async markInterrupted(): Promise<number> {
    const collection = await this.collection();
    const pending = await collection.updateMany(
      { status: "PENDING", review: { $exists: false }, version: ENGINE_VERSION },
      {
        $set: {
          review: {
            reason: "INTERRUPTED",
            statusAtMark: "PENDING",
            markedAt: this.now(),
            detail: "el proceso se reinició con el movimiento a medias",
          },
          updatedAt: new Date(this.now()),
        },
        $unset: { expiresAt: "" },
      },
    );
    const failed = await collection.updateMany(
      { status: "FAILED", review: { $exists: false }, version: ENGINE_VERSION },
      {
        $set: {
          review: {
            reason: "UNDELIVERED",
            statusAtMark: "FAILED",
            markedAt: this.now(),
            detail: "se agotaron los reintentos",
          },
          updatedAt: new Date(this.now()),
        },
        $unset: { expiresAt: "" },
      },
    );
    return pending.modifiedCount + failed.modifiedCount;
  }

  /** What is waiting on a person. Read through here so a screen would not reinvent the question. */
  async needsReview(): Promise<readonly LedgerEntry[]> {
    const documents = await (await this.collection())
      .find({ review: { $exists: true }, version: ENGINE_VERSION })
      .toArray();
    return documents.map(toEntry);
  }

  private async mark(movement: Movement, status: MovementStatus, keep = false): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: keyOf(movement.matchId, movement.playerId, movement.reason) },
      {
        $set: { status, updatedAt: new Date(this.now()) },
        ...(keep ? { $unset: { expiresAt: "" } } : {}),
      },
    );
  }

  /**
   * The expiry index and the room index, created at startup. `expireAfterSeconds: 0`
   * means "when `expiresAt` arrives", which is what lets some rows expire and
   * others not.
   */
  async ensureIndexes(): Promise<void> {
    const collection = await this.collection();
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ roomId: 1 });
  }

  private collection() {
    return this.mongo.collection<MovementDocument>(this.collectionName);
  }
}

const toEntry = (document: MovementDocument): LedgerEntry => ({
  matchId: document.roomId,
  playerId: document.userId,
  amount: document.amount,
  reason: document.reason,
  status: document.status,
  createdAt: document.createdAt.getTime(),
  ...(document.review ? { review: document.review } : {}),
});

// Mongo's 11000 is "duplicate key", and here it means exactly what the ledger means: that movement
// was already written down.
const isDuplicate = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: number }).code === 11000;
