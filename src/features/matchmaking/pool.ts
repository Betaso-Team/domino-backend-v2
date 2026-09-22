import type { Ticket } from "./pool-spec";
export type { Ticket } from "./pool-spec";

// THE QUEUE: the port over matchmaking's shared state — who is waiting, where, and since when.
//
// Today it lives in memory, which is enough because the queue belongs to one process. The day it is
// shared, the implementation changes to Redis and **`take` is the only point that has to become
// atomic**: it is where two processes could take the same player to two different matches. Everything
// else tolerates being stale — looking at an old snapshot of the queue costs one wasted attempt, not
// a broken match.

export interface MatchPool {
  /**
   * Adds to the queue, replacing the same player's previous ticket in the same
   * pool: asking twice is asking once, not holding two places.
   */
  enqueue(ticket: Ticket): Promise<void>;
  cancel(playerId: string, poolId: string): Promise<void>;
  /**
   * Those waiting, IN ARRIVAL ORDER. It is a snapshot: between this read and the
   * `take` the queue can have changed, which is why `take` can fail.
   */
  waiting(poolId: string): Promise<readonly Ticket[]>;
  /**
   * Removes EXACTLY these, all or none. The all-or-nothing is not tidiness: a
   * partial removal would leave a player out of the queue and out of a match,
   * waiting on a pairing that will not come until their search times out.
   *
   * @returns `undefined` when one of them was already gone — somebody else took
   * them — and then the caller tries again on the next tick with a fresh queue.
   */
  take(poolId: string, playerIds: readonly string[]): Promise<readonly Ticket[] | undefined>;
  /** The pools with people waiting. The tick walks these and not a fixed list. */
  activePools(): Promise<readonly string[]>;
}
