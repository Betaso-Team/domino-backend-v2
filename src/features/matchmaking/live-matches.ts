import type { Logger } from "@/shared/logger";

/**
 * IS THIS PLAYER ALREADY PLAYING? Matchmaking's read-only port towards the live
 * matches, and a port rather than a direct call so the matcher can be tested
 * without booting a room. Answering costs a trip to the shared store — the live
 * matches are the CLUSTER's and not this process's — hence the promise.
 *
 * This is what imposes the SINGLE SESSION rule, one active match per account. It
 * is not an antifraude restriction in itself: it is that the three layers that are
 * — cooldown, veto, penalty — are indexed by account, and one account at two
 * tables at once makes them dodgeable. What makes it tolerable is that the answer
 * is not a "no": whoever is already playing receives the reservation of THEIR
 * match, so reopening the app returns them to the table instead of shutting them
 * out.
 */
export interface LiveMatches {
  /**
   * @returns the room of the match they are still playing, or `undefined` when
   * they are in none. A player the engine already retired does NOT count: their
   * match may carry on without them, and holding them to a table where they can do
   * nothing would be the worst of both worlds.
   */
  matchOf(playerId: string): Promise<string | undefined>;
}

/**
 * How many are playing, for the lobby's banner. A second port towards the live
 * matches and not one more method on the one above, because they have nothing in
 * common but where the answer comes from: that one decides, this one only counts.
 * The day the banner goes away, this is deleted and single session never notices.
 *
 * The TOTAL counts everyone, casual and tournament alike, because playing is
 * playing; the breakdown covers only catalog tables, which is what a player picks.
 */
export interface MatchCensus {
  count(): Promise<LiveCensus>;
}

export interface LiveCensus {
  readonly playersInMatch: number;
  readonly byGameMode: ReadonlyMap<string, number>;
}

/** What is shown before the first pass: zeroes, which breaks a banner the least. */
export const NO_ONE: LiveCensus = { playersInMatch: 0, byGameMode: new Map() };

export interface PolledCensusDeps {
  /** Where the count is really taken from, which is the shared store. */
  readonly source: MatchCensus;
  readonly intervalMs: number;
  readonly log: Logger;
}

/**
 * THE COUNT, ON A CLOCK OF ITS OWN instead of on every asker's.
 *
 * It exists because counting is not free: it walks the cluster's whole census and
 * SWEEPS the rooms that died, so it writes as well as reads. That is fine once
 * every few seconds and wrong once per question — and one of the askers is an
 * endpoint with no credential, which is precisely where a per-call read becomes an
 * amplifier anyone can pull.
 *
 * It satisfies the same port it consumes, so whoever already counted goes on
 * counting and finds it free. And it adds the one thing a promise cannot give: the
 * number NOW, with no wait, for a caller that has to answer in the same tick.
 *
 * Its answer can be one interval old, which for a banner is not a defect: what it
 * counts changes at the tables, and nobody is deciding anything with it.
 */
export class PolledCensus implements MatchCensus {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private last: LiveCensus = NO_ONE;

  constructor(private readonly deps: PolledCensusDeps) {}

  /** The count NOW, from memory. */
  current(): LiveCensus {
    return this.last;
  }

  async count(): Promise<LiveCensus> {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs);
    // It must not be what keeps the process alive: a count nobody is reading is no reason to refuse
    // to exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** ONE pass. Public so the suite need not wait a real interval. */
  async check(): Promise<void> {
    // A pass that overlaps the next one would double the cost of the very thing this exists to make
    // cheap.
    if (this.running) return;
    this.running = true;
    try {
      this.last = await this.deps.source.count();
    } catch (e) {
      // The LAST GOOD number is kept and the next pass retries. A hiccup in the store is no reason to
      // tell everyone that nobody is playing.
      this.deps.log.error("la pasada del censo falló", { err: e });
    } finally {
      this.running = false;
    }
  }
}
