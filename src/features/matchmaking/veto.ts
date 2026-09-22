import type { KeyValueStore } from "@/shared/kv";

// THE PAIR VETO: two accounts that just crossed paths stop preferring each other as rivals for a
// while. The second of the three layers against an immediate rematch, aimed at the pattern of two
// accomplices facing each other over and over.
//
// It is a PREFERENCE and not a block, and that distinction does not live here: this piece only
// records and answers. Who prefers whom is decided by `core/grouping`, which respects it while it
// can and drops it rather than leave anyone without a match.
//
// **One book for both scopes.** The axis is called `scope` and not `tournamentId` because what
// changes between casual and tournament is what is vetoed and for how long, not how:
//
//   casual      → a global scope per account, renewable. Being vetoed at one table vetoes at all of
//                 them, because otherwise two accomplices change table and the veto does not exist.
//   tournament  → scope is the tournament, fixed. A tournament is already bounded in time and the
//                 veto cannot outlive it: it would have nobody to apply to.
//
// Bidirectional and idempotent: vetoing the same pair twice only renews the expiry.
//
// **Stored in Redis, under v1's keys.** One SET per account holding the vetoed accounts, and the
// bidirectional veto written TWICE — once per owner — rather than one key per ordered pair. Not the
// shape we would choose from scratch (the expiry belongs to the whole set, so vetoing someone new
// renews everyone), but the one already written in production: sharing it is what makes a veto set
// by one engine visible to the other.

/**
 * The casual global scope. A constant and not a game mode id on purpose: the
 * casual veto is per account, with no table, and that is its reason to exist.
 */
export const CASUAL_SCOPE = "CASUAL";

export interface VetoConfig {
  readonly ttlMs: number;
}

/**
 * Which key this scope's veto hangs off. A parameter because the two scopes do
 * NOT share a key shape: the casual one is global per account and the
 * tournament one carries the tournament inside.
 */
export type VetoKey = (scope: string, playerId: string) => string;

export const casualVetoKey: VetoKey = (_scope, playerId) => `casual_pair_veto:${playerId}`;
export const tournamentVetoKey: VetoKey = (scope, playerId) =>
  `tournament_veto:${scope}:${playerId}`;

export class VetoBook {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly keyOf: VetoKey,
    private readonly config: VetoConfig,
  ) {}

  async register(scope: string, playerIds: readonly string[]): Promise<void> {
    const ttl = Math.round(this.config.ttlMs / 1000);
    await Promise.all(
      pairsOf(playerIds).flatMap(([a, b]) => [
        this.remember(scope, a, b, ttl),
        this.remember(scope, b, a, ttl),
      ]),
    );
  }

  async isVetoed(scope: string, a: string, b: string): Promise<boolean> {
    return (await this.vetoedFor(scope, a)).includes(b);
  }

  /**
   * Who this player would rather not cross paths with, right now. It is what
   * matchmaking puts on the ticket, and with this key shape it is ONE read.
   */
  async vetoedFor(scope: string, playerId: string): Promise<readonly string[]> {
    return this.kv.smembers(this.keyOf(scope, playerId));
  }

  // The expiry is renewed over the WHOLE set, which is how v1 does it: the TTL counts from the last
  // encounter and not the first.
  private async remember(
    scope: string,
    owner: string,
    partner: string,
    ttl: number,
  ): Promise<void> {
    if (!owner || !partner || owner === partner) return;
    const key = this.keyOf(scope, owner);
    await this.kv.sadd(key, partner);
    await this.kv.expire(key, ttl);
  }
}

// Every pair at the table. One in 1v1, six in 2v2, because the veto is between ACCOUNTS — who
// crossed paths — and not between teams: two accomplices as partners are the same pattern.
function pairsOf(playerIds: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < playerIds.length; i++)
    for (let j = i + 1; j < playerIds.length; j++) {
      const a = playerIds[i];
      const b = playerIds[j];
      if (a && b) out.push([a, b]);
    }
  return out;
}
