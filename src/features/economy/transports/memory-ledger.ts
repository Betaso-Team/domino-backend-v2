import {
  DuplicateMovementError,
  type Ledger,
  type LedgerEntry,
  type MovementStatus,
  keyOf,
} from "../ledger";
import type { Movement, MovementReason } from "../wallet";

/** Single-process ledger used by development and the service-free test suite. */
export class MemoryLedger implements Ledger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async reserve(movement: Movement): Promise<LedgerEntry> {
    const key = keyOf(movement.matchId, movement.playerId, movement.reason);
    if (this.entries.has(key)) throw new DuplicateMovementError(key);
    const entry: LedgerEntry = { ...movement, status: "PENDING", createdAt: this.now() };
    this.entries.set(key, entry);
    return entry;
  }

  async settle(movement: Movement): Promise<void> {
    this.mark(movement, "SETTLED");
  }

  async fail(movement: Movement): Promise<void> {
    this.mark(movement, "FAILED");
  }

  async has(matchId: string, playerId: string, reason: MovementReason): Promise<boolean> {
    return this.entries.has(keyOf(matchId, playerId, reason));
  }

  async statusOf(
    matchId: string,
    playerId: string,
    reason: MovementReason,
  ): Promise<MovementStatus | undefined> {
    return this.entries.get(keyOf(matchId, playerId, reason))?.status;
  }

  async entriesOf(matchId: string): Promise<readonly LedgerEntry[]> {
    return [...this.entries.values()].filter((entry) => entry.matchId === matchId);
  }

  private mark(movement: Movement, status: MovementStatus): void {
    const key = keyOf(movement.matchId, movement.playerId, movement.reason);
    const entry = this.entries.get(key);
    if (entry) this.entries.set(key, { ...entry, status });
  }
}
