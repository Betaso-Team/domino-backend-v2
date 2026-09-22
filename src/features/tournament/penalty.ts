import type { KeyValueStore } from "@/shared/kv";
import type { TournamentConfig } from "./config";

// THE STRIKES: walking out of a tournament match costs, and costs more each time. The rule lives in
// one piece here rather than spread between module constants, a key and an inline computation.

export interface Penalty {
  readonly strikes: number;
  /** Until when they cannot ask for a match, as an epoch in milliseconds. 0 means they can. */
  readonly blockedUntil: number;
}

/**
 * The ladder, pure: how many minutes of penalty N walkouts earn. The first strikes
 * are merely recorded — a first walkout can be a real disconnection, and punishing
 * it would be punishing bad luck — and past the threshold each one weighs one rung
 * more.
 */
export function penaltyMinutesFor(strikes: number, config: TournamentConfig): number {
  if (strikes < config.minStrikesForPenalty) return 0;
  return config.penaltyMinutesPerStrike * (strikes - config.minStrikesForPenalty + 1);
}

// What is stored in Redis. The names are v1's because both engines share the key.
interface Record {
  readonly strikes: number;
  readonly penalizedUntil: string | null;
}

/**
 * The register of walkouts, by tournament and player. The DECAY is the key's own
 * expiry: every new strike renews it, so the ladder measures sustained repetition
 * and forgives whoever walked out once a day ago. There is no need to store when
 * the last one was: Redis is what knows.
 */
export class StrikeBook {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly config: TournamentConfig,
    private readonly now: () => number,
  ) {}

  /** Adds a walkout and returns the resulting penalty. */
  async add(tournamentId: string, playerId: string): Promise<Penalty> {
    const now = this.now();
    const previous = await this.recordOf(tournamentId, playerId);
    const strikes = (previous?.strikes ?? 0) + 1;
    const minutes = penaltyMinutesFor(strikes, this.config);
    const blockedUntil = minutes > 0 ? now + minutes * 60_000 : 0;
    const record: Record = {
      strikes,
      penalizedUntil: blockedUntil > 0 ? new Date(blockedUntil).toISOString() : null,
    };
    await this.kv.setex(
      this.keyOf(tournamentId, playerId),
      JSON.stringify(record),
      Math.round(this.config.strikesDecayMs / 1000),
    );
    return { strikes, blockedUntil };
  }

  /** What matchmaking consults before letting anyone into the queue. */
  async penaltyOf(tournamentId: string, playerId: string): Promise<Penalty> {
    const record = await this.recordOf(tournamentId, playerId);
    if (!record) return { strikes: 0, blockedUntil: 0 };
    const until = record.penalizedUntil ? Date.parse(record.penalizedUntil) : 0;
    return {
      strikes: record.strikes,
      blockedUntil: until > this.now() ? until : 0,
    };
  }

  async isBlocked(tournamentId: string, playerId: string): Promise<boolean> {
    return (await this.penaltyOf(tournamentId, playerId)).blockedUntil > 0;
  }

  private async recordOf(tournamentId: string, playerId: string): Promise<Record | undefined> {
    const raw = await this.kv.get(this.keyOf(tournamentId, playerId));
    if (!raw) return undefined;
    // Written by v1 or by us; either way it is read with suspicion. An unreadable record is the same
    // as no record: nobody is punished over broken JSON.
    try {
      const value = JSON.parse(raw) as Partial<Record>;
      if (typeof value.strikes !== "number") return undefined;
      return { strikes: value.strikes, penalizedUntil: value.penalizedUntil ?? null };
    } catch {
      return undefined;
    }
  }

  private keyOf(tournamentId: string, playerId: string): string {
    return `tournament_penalty:${tournamentId}:${playerId}`;
  }
}
