import type { MatchPool, Ticket } from "../pool";

/**
 * TODAY'S queue: in memory, inside the process.
 *
 * What it will cost the day the queue is shared is confined to `take`, which is
 * why it is written as a single operation even though it is trivial here: it is
 * the only point where two processes could take the same player to two matches.
 * Against Redis that is an atomic script or a transaction; the rest of the
 * methods translate without thinking.
 */
export class MemoryMatchPool implements MatchPool {
  // One map per pool, and inside it by player: queueing twice replaces rather than holding two
  // places. `Map` keeps insertion order, which here IS arrival order.
  private readonly pools = new Map<string, Map<string, Ticket>>();

  async enqueue(ticket: Ticket): Promise<void> {
    const queue = this.pools.get(ticket.poolId) ?? new Map<string, Ticket>();
    queue.set(ticket.playerId, ticket);
    this.pools.set(ticket.poolId, queue);
  }

  async cancel(playerId: string, poolId: string): Promise<void> {
    const queue = this.pools.get(poolId);
    if (!queue) return;
    queue.delete(playerId);
    // An empty pool is deleted rather than left as an empty `Map`, so `activePools` is exactly
    // "those with people" and the tick does not walk yesterday's leftovers.
    if (queue.size === 0) this.pools.delete(poolId);
  }

  async waiting(poolId: string): Promise<readonly Ticket[]> {
    return [...(this.pools.get(poolId)?.values() ?? [])];
  }

  async take(poolId: string, playerIds: readonly string[]): Promise<readonly Ticket[] | undefined> {
    const queue = this.pools.get(poolId);
    if (!queue) return undefined;
    // ALL of them are checked before any is removed. A partial removal would leave someone out of
    // the queue and out of a match, waiting on a pairing that can no longer arrive.
    const tickets = playerIds.map((id) => queue.get(id));
    if (tickets.some((t) => t === undefined)) return undefined;

    for (const id of playerIds) queue.delete(id);
    if (queue.size === 0) this.pools.delete(poolId);
    return tickets as Ticket[];
  }

  async activePools(): Promise<readonly string[]> {
    return [...this.pools.keys()];
  }
}
