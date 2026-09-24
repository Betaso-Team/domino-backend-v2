import type { Logger } from "@/shared/logger";
import { type RetryPolicy, withRetries } from "@/shared/retry";
import { newTrace, withTrace } from "@/shared/trace";

// THE REPORT: one row per player per match, which the main backend accumulates into the standings. It
// is the only thing the truco sends it about the result, and what moves the tournament's score.

export interface Participation {
  readonly tournamentId: string;
  readonly matchId: string;
  readonly playerId: string;
  readonly username: string;
  readonly profilePicture: string;
  /** What it adds to the STANDINGS: the quality score on a win, `pointsPerLoss` on a loss. */
  readonly score: number;
  /**
   * How many piedras the truco match closed with. Not the same as `score` and not
   * to be mixed with it: one belongs to the tournament and the other to the game.
   */
  readonly matchScore: number;
  readonly wins: number;
  readonly losses: number;
  readonly gamesPlayed: number;
  /**
   * The TRAIL of why the score was what it was. Declaring these fields and never
   * sending them leaves the operator unable to answer "why did this match give me 1
   * point?" — the worst place to come up short, for an antifraude mechanism that
   * will be disputed.
   */
  readonly roundsPlayed: number;
  readonly durationMs: number;
  readonly qualityRatio: number;
  readonly grade: number;
}

/**
 * The outbound port: how the report travels. There is no decision on the other
 * side to wait for, which is why it goes through an outbox and not inline.
 */
export interface ParticipationTransport {
  send(participation: Participation): Promise<void>;
}

// Same policy as the money movements: a delivery failure is retried, not forgotten.
const DELIVERY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500 };

/**
 * Guaranteed delivery of the report. It shares the retry loop with `economy`'s
 * outbox and nothing else: each has its own register and its own notion of a
 * duplicate.
 *
 * The idempotency key is `(tournament, match, player)`: the main backend increments
 * the standings, so reporting the same match twice ADDS twice. This is the guard
 * that prevents it, and that is why it belongs to the truco and not to the other
 * side.
 */
export class ParticipationReporter {
  private readonly sent = new Set<string>();
  private readonly failed: Participation[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly transport: ParticipationTransport,
    private readonly log: Logger,
  ) {}

  /**
   * Synchronous: a listener calls it.
   *
   * @returns whether it was queued. `false` means it had already been reported.
   */
  report(participation: Participation): boolean {
    const key = this.keyOf(participation);
    if (this.sent.has(key)) return false;
    this.sent.add(key);
    // Each report is its own cause, for the same reason as each prize delivery: a synchronous
    // listener calls it, and the chain that starts crosses to the queue and from there to the
    // main backend.
    withTrace(newTrace(), () => this.track(this.deliver(participation)));
    return true;
  }

  /** The ones that never landed. Kept in sight for reconciliation instead of being lost. */
  get unreported(): readonly Participation[] {
    return this.failed;
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Stops retrying and waits out what is already under way. Called on shutdown. */
  async close(): Promise<void> {
    this.shutdown.abort();
    await this.drain();
  }

  private track(delivery: Promise<void>): void {
    this.inFlight.add(delivery);
    // As in `economy`'s outbox: a `void` over a chain that can reject is a way to bring the whole
    // process down, because Node terminates on an unhandled rejection.
    void delivery
      .catch((e: unknown) => this.log.error("entrega con fallo no previsto", { err: e }))
      .finally(() => this.inFlight.delete(delivery));
  }

  private async deliver(participation: Participation): Promise<void> {
    const key = this.keyOf(participation);
    const delivered = await withRetries(() => this.transport.send(participation), DELIVERY_POLICY, {
      signal: this.shutdown.signal,
      // While attempts remain it is `warn`: it can still land. The `error` is the one below.
      onAttemptFailed: (err, attempt, willRetry) =>
        this.log.warn("falló un intento de reporte", {
          err,
          attempt,
          willRetry,
          participationKey: key,
        }),
    });
    if (!delivered) {
      // The key is released: if it never landed, a later retry has to be able to try again.
      this.sent.delete(key);
      this.failed.push(participation);
      // The tournament's score depends on this, so a participation that did not land is exactly the
      // `error` case: someone has to look.
      this.log.error("reporte de participación NO entregado", { participationKey: key });
      return;
    }
    this.log.info("participación reportada", { participationKey: key });
  }

  private keyOf(p: Participation): string {
    return `${p.tournamentId}:${p.matchId}:${p.playerId}`;
  }
}
