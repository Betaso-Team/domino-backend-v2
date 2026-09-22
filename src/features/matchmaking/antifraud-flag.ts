import type { Logger } from "@/shared/logger";

// THE SWITCH over the do-not-repeat-a-rival rules. It lives in the main backend, with an admin panel,
// and is born ON. Product turns it off without a deploy when those rules do more harm than good — the
// typical case being few people online: with a thin pool, avoiding pairs lengthens the waits and
// people leave.
//
// It governs ONLY the casual pair veto and the rematch chain limit. It does NOT govern the cooldown,
// the tournament veto or the strikes: those are of another nature and are not turned off for
// matchmaking's convenience.
//
// **On error the veto STAYS IN FORCE.** The opposite stance — "never block over a problem of ours" —
// sounds good until one notices that whoever can take that endpoint down turns the protection off.
// The safe side is preferred here, and the cost is bounded: the veto is a preference, so the worst
// that can happen with the backend down is someone waiting until the escape hatch before being
// paired anyway.

export interface AntifraudFlag {
  isRematchRulesEnabled(): Promise<boolean>;
}

/**
 * Wraps the real one with a short cache and coalescing. Both are needed for the
 * same reason: this is consulted when EVERY match closes and when EVERY player
 * queues, so without the cache it would be dozens of calls per second to the main
 * backend, and without coalescing N rooms closing at once would produce N
 * identical calls in flight.
 */
export class CachedAntifraudFlag implements AntifraudFlag {
  private cache?: { value: boolean; expiresAt: number };
  private inFlight?: Promise<boolean>;

  constructor(
    private readonly source: AntifraudFlag,
    // Seconds and not minutes: the toggle has to take effect almost immediately.
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  async isRematchRulesEnabled(): Promise<boolean> {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.value;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.source
      .isRematchRulesEnabled()
      .catch((e) => {
        // Fail-safe ON. See the note above.
        this.log.error("no se pudo leer el flag antifraude: se asume ENCENDIDO", { err: e });
        return true;
      })
      .then((value) => {
        this.cache = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }
}
