import type { AmqpDelivery } from "@/shared/amqp";
import type { Logger } from "@/shared/logger";
import type { TournamentClient } from "./client";

// THE WATCHER: the one thing a tournament is still waiting on to pay out. The main backend marks a
// tournament finished when its schedule says so, but it cannot hand out the prizes until it knows no
// match is still being played — and the only one that knows is the truco server.
//
// It is a per-PROCESS service and not a room: living in a room would mean killing that room kills the
// notice and the tournament goes unpaid. It runs as long as the server does.
//
// **The pace is a couple of minutes** and its being slow does not matter: nobody is waiting on the
// other side of a screen, what is unblocked is a payout already decided.

const BETASO_EXCHANGE = "betaso";
const GAMES_CHECK_KEY = "tournament.games-check";

export interface TournamentWatcherDeps {
  // The CACHED client: this polls, it does not decide. Whoever decides reads fresh.
  readonly client: TournamentClient;
  readonly publisher: AmqpDelivery;
  // WHICH TOURNAMENTS have matches left. It arrives as an opaque function because `match` holds the
  // answer and this feature cannot import it; the composition root is the only one that knows both.
  readonly liveTournaments: () => Promise<readonly string[]>;
  readonly intervalMs: number;
  readonly log: Logger;
}

export class TournamentWatcher {
  // THE TOURNAMENTS IT WATCHES. They enter when seen with a match and leave only in a terminal
  // state, not when they run out of matches: the very notice that has to be given — "none are left" —
  // is given when none are left, so forgetting them at that moment would be withholding the one
  // answer the other side is waiting for.
  private readonly watched = new Set<string>();
  private ticking?: ReturnType<typeof setInterval>;
  private running = false;
  // The pass under way, so it can be AWAITED on shutdown: if the process dies with a notice half
  // published, that tournament goes without its answer until someone looks again.
  private inFlight?: Promise<void>;

  constructor(private readonly deps: TournamentWatcherDeps) {}

  start(): void {
    if (this.ticking) return;
    this.ticking = setInterval(() => void this.tick(), this.deps.intervalMs);
    this.ticking.unref?.();
  }

  stop(): void {
    if (this.ticking) clearInterval(this.ticking);
    this.ticking = undefined;
  }

  /**
   * Cuts the interval and waits for the pass under way to finish. Called on an
   * ordered shutdown, like the outbox's and the reporter's, and for the same
   * reason: what is on its way out has to be able to leave.
   */
  async close(): Promise<void> {
    this.stop();
    await this.inFlight;
  }

  /** ONE pass. Public so the suite need not wait a real interval. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.inFlight = this.pass().finally(() => {
      this.running = false;
    });
    return this.inFlight;
  }

  private async pass(): Promise<void> {
    const live = new Set(await this.deps.liveTournaments());
    for (const tournamentId of live) this.watched.add(tournamentId);

    for (const tournamentId of [...this.watched]) {
      // Each tournament gets its own try: one that fails cannot leave the rest unanswered, which is
      // what a single try around the loop would do.
      try {
        await this.check(tournamentId, live.has(tournamentId));
      } catch (e) {
        this.deps.log.error("no se pudo revisar el torneo", { err: e, tournamentId });
      }
    }
  }

  private async check(tournamentId: string, hasPendingGames: boolean): Promise<void> {
    const { status } = await this.deps.client.infoOf(tournamentId);

    // It is still being played: there is nothing to answer. The backend does not ask during a
    // tournament, it asks once it has declared it finished.
    if (status !== "FINISHED") {
      // Paid and cancelled are terminal: there is nothing left to expect from this tournament, and
      // going on watching it would mean holding it forever.
      if (status === "PAID" || status === "CANCELED") this.watched.delete(tournamentId);
      return;
    }

    // It answers with whatever holds, including that matches ARE left: the other side records it and
    // goes back to waiting. What unblocks the payout is the `false`, which is why the tournament
    // keeps being watched until the backend itself says it has paid.
    await this.deps.publisher.publishTopic(BETASO_EXCHANGE, GAMES_CHECK_KEY, {
      tournamentId,
      hasPendingGames,
    });
  }
}
