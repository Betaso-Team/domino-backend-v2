import type { KeyValueStore } from "@/shared/kv";
// THE STAGGERED COOLDOWN: the first of the three layers against an immediate rematch.
//
// When a match closes each player is handed a DIFFERENT delay before they can return to the queue.
// That they differ is the whole point, and it is worth keeping in mind because it looks like a
// detail: if both re-entered at once, each would create their own wait and the veto's escape hatch
// would have nobody to pair — both passive, nobody searching. Staggering them guarantees that when
// the second arrives, the first is already waiting.
//
// It is neither a punishment nor a block: it is seconds, and it applies to everyone alike whatever
// they did. All it does is desynchronise them.

export interface CooldownConfig {
  // The shortest and the longest of the spread. With two players they are exactly that.
  readonly shortMs: number;
  readonly longMs: number;
  // How long an unconsumed delay lives. Cleanup, not policy: if the player does not come back, the
  // note forgets itself.
  readonly ttlMs: number;
}

export const DEFAULT_COOLDOWN: CooldownConfig = {
  shortMs: 2_000,
  longMs: 7_000,
  ttlMs: 60_000,
};

/**
 * The spread for `n` players: the first gets the short one, the last the long
 * one, the rest spaced in between.
 */
export function cooldownLadder(n: number, config: CooldownConfig): number[] {
  if (n <= 0) return [];
  if (n === 1) return [config.shortMs];
  const span = config.longMs - config.shortMs;
  return Array.from({ length: n }, (_, i) => config.shortMs + (span * i) / (n - 1));
}

// What is stored in Redis. The NAMES and the UNITS are v1's — seconds for the delay, epoch
// milliseconds for the instant — because both engines share the key: whoever writes it may not be
// whoever reads it.
interface Assigned {
  readonly delaySeconds: number;
  readonly assignedAt: number;
}

/**
 * The register of pending delays, by scope and player. In Redis, under v1's key
 * and its one-minute expiry: past that the note expires on its own and whoever
 * comes back late does not wait twice.
 */
export class CooldownBook {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly config: CooldownConfig,
    private readonly now: () => number,
    // Who gets the short delay is RANDOM. Without this one player would be systematically favoured —
    // the first of the list always re-enters sooner — and over time that shows.
    private readonly shuffle: <T>(items: readonly T[]) => T[] = fisherYates,
  ) {}

  /**
   * Hands the spread out among those who just played. `scope` isolates contexts —
   * the table in casual, the tournament in a tournament — because one table's
   * delay has no business holding up entry to another.
   */
  async assign(scope: string, playerIds: readonly string[]): Promise<void> {
    const unique = this.shuffle([...new Set(playerIds.filter(Boolean))]);
    if (unique.length < 2) return;
    const delays = cooldownLadder(unique.length, this.config);
    const assignedAt = this.now();
    const ttl = Math.round(this.config.ttlMs / 1000);
    await Promise.all(
      unique.map((playerId, i) => {
        const payload: Assigned = {
          delaySeconds: Math.round((delays[i] as number) / 1000),
          assignedAt,
        };
        return this.kv.setex(this.keyOf(scope, playerId), JSON.stringify(payload), ttl);
      }),
    );
  }

  /**
   * How many milliseconds they still have to wait, CONSUMING the note: it is
   * single-use. The time already elapsed since it was assigned is discounted, so
   * whoever takes a while to return does not wait twice.
   */
  async consume(scope: string, playerId: string): Promise<number> {
    const key = this.keyOf(scope, playerId);
    const raw = await this.kv.get(key);
    if (!raw) return 0;
    this.kv.del(key);
    const assigned = parse(raw);
    if (!assigned) return 0;
    const elapsed = this.now() - assigned.assignedAt;
    if (elapsed >= this.config.ttlMs) return 0;
    return Math.max(0, assigned.delaySeconds * 1000 - elapsed);
  }

  private keyOf(scope: string, playerId: string): string {
    return `matchmaking_cooldown:${scope}:${playerId}`;
  }
}

// What is on the other side may have been written by v1, so it is read with suspicion: a note that
// cannot be understood is the same as no note — nobody waits extra over broken JSON.
function parse(raw: string): Assigned | undefined {
  try {
    const value = JSON.parse(raw) as Partial<Assigned>;
    if (typeof value.delaySeconds !== "number" || typeof value.assignedAt !== "number")
      return undefined;
    return { delaySeconds: value.delaySeconds, assignedAt: value.assignedAt };
  } catch {
    return undefined;
  }
}

function fisherYates<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
