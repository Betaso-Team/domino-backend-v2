import type { Logger } from "@/shared/logger";
import { sleep } from "@/shared/sleep";
import { newTrace, withTrace } from "@/shared/trace";
import type { MatchmakingConfig } from "./config";
import type { CooldownBook } from "./core/cooldown";
import { formGroup } from "./core/grouping";
import { MatchmakingError, type MatchmakingErrorReason } from "./errors";
import type { MatchGateway, Seat } from "./gateway";
import type { LiveMatches } from "./live-matches";
import type { MaintenanceSignal } from "./maintenance";
import type { MatchPool, Ticket } from "./pool";
import type { PoolDirectory, PoolRequest, PoolSpec, Requester } from "./pool-spec";

/**
 * THE MATCHER: what pairs people up, knowing nothing of the transport. It asks the
 * scope for a spec, queues the ticket, and on every tick looks at the queues to
 * see whether a group is there. When it is, it asks the gateway to open the match
 * and hands each player their seat.
 *
 * **One request, one answer.** `request` returns a promise that resolves when the
 * player enters a group, and rejects on timeout or cancellation. That is what
 * avoids the notification port a loose tick would need: the waiting stays on the
 * side that holds the socket, and the `AbortSignal` is the same idiom the rest of
 * the repo already uses.
 */

interface Waiter {
  readonly poolId: string;
  readonly resolve: (seat: Seat) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface MatchmakerDeps {
  readonly directory: PoolDirectory;
  readonly pool: MatchPool;
  readonly gateway: MatchGateway;
  // UNA FUNCIÓN y no los valores, como `now` y `seedOf`: lo que contesta se puede editar con el
  // servidor andando, y todo lo que se lee AL USAR toma el cambio sin reiniciar. Lo que se lee al
  // arrancar —el tick— no es editable (`config-schema.ts`).
  readonly config: () => MatchmakingConfig;
  // The first antifraude layer: it delays the re-entry of those who just played, and DESYNCHRONISES
  // them.
  readonly cooldown: CooldownBook;
  // Matches IN PROGRESS, for the single-session rule. A port: the matcher knows no rooms.
  readonly live: LiveMatches;
  // THE DOOR TO THE GAME. It goes here and not in the lobby because the lobby is transport: closing
  // access is a matchmaking decision, and putting it on the other side would leave it out of every
  // test that does not boot a server.
  //
  // It is the SIGNAL and not the book: it is consulted on every request, so going to the database
  // each time would be one read per player. The signal answers from memory and keeps itself current.
  readonly maintenance: MaintenanceSignal;
  readonly now: () => number;
  // The match seed, which goes into the room options. Injected so the suite can fix it: the deal
  // depends on it.
  readonly seedOf: () => string;
  readonly log: Logger;
}

export class Matchmaker {
  private ticking?: ReturnType<typeof setInterval>;
  // Who is waiting for an answer, by player. It lives here and not in the queue because it is the
  // ONLY part of matchmaking that is local to this process: the promise hangs off the lobby's socket.
  private readonly waiters = new Map<string, Waiter>();
  // How to stop listening to the switch. Hooked on start and released on stop: a stopped matcher
  // still attached to a process-wide signal would keep reacting after it died.
  private unwatch?: () => void;
  // Keeps two ticks from overlapping when one takes longer than the interval. Without it, the second
  // would look at the same queue and form the same group.
  private running = false;

  constructor(private readonly deps: MatchmakerDeps) {}

  start(): void {
    if (this.ticking) return;
    this.ticking = setInterval(() => void this.tick(), this.deps.config().tickIntervalMs);
    // A pending interval must not hold the process open. Without it, the suite would never finish.
    this.ticking.unref?.();
    // MAINTENANCE EMPTIES THE QUEUES, and the subscription lives here and not in the composition
    // root because what a maintenance means TO THE QUEUE is the matcher's business: leaving it
    // outside would be something someone could forget to wire and no test of this class would cover.
    this.unwatch = this.deps.maintenance.onChange((maintenance) => {
      if (maintenance.isUnderMaintenance) void this.closeQueues("MAINTENANCE");
    });
  }

  /**
   * Cuts the tick and closes out whoever was waiting. Called on an ordered
   * shutdown: leaving them hanging would mean their client waits for a match that
   * can no longer arrive.
   */
  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    if (this.ticking) clearInterval(this.ticking);
    this.ticking = undefined;
    for (const playerId of [...this.waiters.keys()]) {
      this.settle(playerId, (w) => w.reject(new MatchmakingError("RESTARTING")));
    }
  }

  /**
   * EMPTIES THIS PROCESS'S QUEUES, saying why. It is the other half of the
   * maintenance switch: the door stops people GETTING IN, this takes out those who
   * were already inside. Without it the tick would keep pairing up whoever queued
   * before the switch was pulled, and the rest would wait in silence until their
   * search timed out — two minutes watching a screen where nothing will happen.
   *
   * Walking the ones THIS process has waiting is enough because the queue is its
   * own: every live ticket has its promise here. The day the queue is shared, this
   * stays correct for its own and each instance does the same with theirs.
   */
  async closeQueues(reason: MatchmakingErrorReason): Promise<void> {
    // Over a COPY: `settle` deletes from the map while it is being walked.
    for (const [playerId, waiter] of [...this.waiters]) {
      this.settle(playerId, (w) => w.reject(new MatchmakingError(reason)));
      await this.deps.pool.cancel(playerId, waiter.poolId);
    }
  }

  /**
   * How many are waiting, per queue. It is for the lobby's banner and decides
   * nothing: it walks the pools that have people and counts, without adding a
   * method to the port.
   *
   * The breakdown covers catalog tables only — a casual pool's `poolId` IS the
   * game mode id — while the total counts everyone: waiting for a tournament to
   * fill is waiting too. Which is which comes from the ticket, which keeps the
   * request exactly as it arrived.
   */
  async waiting(): Promise<{ total: number; byGameMode: ReadonlyMap<string, number> }> {
    let total = 0;
    const byGameMode = new Map<string, number>();
    for (const poolId of await this.deps.pool.activePools()) {
      const tickets = await this.deps.pool.waiting(poolId);
      total += tickets.length;
      if (tickets[0]?.request.kind === "CASUAL") byGameMode.set(poolId, tickets.length);
    }
    return { total, byGameMode };
  }

  /**
   * ONE request, ONE answer. It can take a while: the search timeout is in the
   * order of minutes.
   *
   * @throws {MatchmakingError} `ALREADY_IN_MATCH` when they are in a match they
   * cannot be returned to, `MAINTENANCE` while the game is closed, `TIMEOUT` when
   * the search expires, `CANCELLED` when the signal aborts, plus whatever the
   * scope's own admission refuses with.
   */
  async request(request: PoolRequest, requester: Requester, signal: AbortSignal): Promise<Seat> {
    const { playerId } = requester;
    // SINGLE SESSION, and it goes before everything else: someone already playing needs nothing
    // asked of the scope — no balance, no enrolment — because they are not entering a new table.
    // What they asked for is not even read: if they have a match in progress, the answer is THAT one.
    const live = await this.deps.live.matchOf(playerId);
    if (live) return await this.rejoin(live, playerId);

    // MAINTENANCE, and it goes AFTER the single-session check on purpose: what closes is entry to a
    // NEW match, not the return to one already being played. Cutting off re-entry for someone with a
    // live table would leave them losing on time with their entry fee paid — and that match ends
    // either way, because a maintenance does not kill rooms.
    //
    // The message does not travel through here: the client receives the REASON and the lobby pushes
    // the text. It rides along in the exception all the same, for the server log.
    //
    // The value can be up to one poll interval stale, and that is safe: whoever slips through that
    // window is taken out by `closeQueues` on the same pass that detects the change.
    const maintenance = this.deps.maintenance.current();
    if (maintenance.isUnderMaintenance)
      throw new MatchmakingError("MAINTENANCE", maintenance.message);

    const spec = await this.deps.directory.specOf(request);
    // The scope's restrictions are paid HERE, once per request: asking about a balance or an
    // enrolment on every tick would be one network call per player every 250 ms.
    await spec.admit(requester);

    // The cooldown is charged BEFORE queueing and not after: what it is after is that two people who
    // just played do not return to the queue at the same instant. It is single-use, so consuming it
    // here also means someone who cancels and asks again does not pay it twice.
    const wait = await this.deps.cooldown.consume(spec.poolId, playerId);
    if (wait > 0) await sleep(wait, signal);
    if (signal.aborted) throw new MatchmakingError("CANCELLED");

    const avoid = await spec.avoid(playerId);

    const seat = new Promise<Seat>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(playerId, (w) => w.reject(new MatchmakingError("TIMEOUT")));
        void this.deps.pool.cancel(playerId, spec.poolId);
      }, this.deps.config().searchTimeoutMs);
      timer.unref?.();
      this.waiters.set(playerId, { poolId: spec.poolId, resolve, reject, timer });
    });

    const onAbort = (): void => {
      this.settle(playerId, (w) => w.reject(new MatchmakingError("CANCELLED")));
      void this.deps.pool.cancel(playerId, spec.poolId);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The cancellation may have arrived BEFORE the handler was attached: asking the scope takes a
    // few `await`s, and cancelling is a message travelling down the same socket right behind the
    // request. An already-aborted `AbortSignal` does NOT notify whoever attaches afterwards, so
    // without this check the ticket would sit in the queue and the promise hang until the search
    // timed out.
    if (signal.aborted) onAbort();

    const ticket: Ticket = {
      playerId,
      poolId: spec.poolId,
      request,
      enqueuedAt: this.deps.now(),
      avoid,
    };
    await this.deps.pool.enqueue(ticket);
    // Enqueueing and cancelling are TWO steps, and the abort can land right in the gap — or even
    // earlier, when the ticket did not exist yet and there was nothing to remove. It is checked
    // again: `onAbort` is idempotent, and a ghost ticket in the queue costs far more than this check.
    if (signal.aborted) onAbort();
    // Otherwise it tries right away: if the rival was already waiting there is no reason to charge
    // both of them the tick interval. The tick is the safety net, not the normal path.
    else void this.tick();
    return seat;
  }

  // Returning them to their match. When the seat cannot be given, the reason is almost always that
  // the table is FULL because they are still connected from somewhere else, and there the refusal is
  // the right answer: two connections playing one seat is exactly what single session prevents.
  private async rejoin(roomId: string, playerId: string): Promise<Seat> {
    try {
      return await this.deps.gateway.rejoin(roomId, playerId);
    } catch (e) {
      this.deps.log.error("no se pudo devolver a su partida", { err: e, roomId });
      throw new MatchmakingError("ALREADY_IN_MATCH");
    }
  }

  /** ONE pass over every queue with people in it. Public so the suite need not wait a real interval. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const poolId of await this.deps.pool.activePools()) {
        // One pool can yield several groups at once — eight waiting at a two-seat table — so it
        // keeps going while there are any.
        while (await this.formOne(poolId)) {
          // the work is done by `formOne`
        }
      }
    } catch (e) {
      // A tick that blows up cannot take the interval with it: without this, a transient gateway
      // failure would leave matchmaking dead until the next restart.
      this.deps.log.error("el tick del emparejamiento falló", { err: e });
    } finally {
      this.running = false;
    }
  }

  private async formOne(poolId: string): Promise<boolean> {
    const waiting = await this.deps.pool.waiting(poolId);
    if (waiting.length === 0) return false;
    const spec = await this.specOfPool(poolId, waiting);
    if (!spec) return false;

    const group = formGroup(waiting, {
      seats: spec.seats,
      now: this.deps.now(),
      vetoBypassMs: this.deps.config().vetoBypassMs,
      candidates: this.deps.config().groupingCandidates,
    });
    if (!group) return false;

    // Taking them out is the point of no return, and it is all-or-nothing: if someone else took one
    // of them, nothing is opened and the queue is looked at again.
    const taken = await this.deps.pool.take(
      poolId,
      group.map((t) => t.playerId),
    );
    if (!taken) return false;

    try {
      const seats = await withTrace(newTrace(), () =>
        this.deps.gateway.open(spec.toRoomOptions(group, this.deps.seedOf())),
      );
      for (const seat of seats) this.settle(seat.playerId, (w) => w.resolve(seat));
    } catch (e) {
      // The match could not be opened. They go back to the queue instead of being refused: whoever
      // was waiting did nothing wrong, and their search timeout keeps running either way.
      for (const ticket of taken) await this.deps.pool.enqueue(ticket);
      this.deps.log.error("no se pudo abrir la partida", { err: e });
      return false;
    }
    return true;
  }

  // The pool's spec, derived from whoever is waiting. Rebuilt on every pass and deliberately not
  // cached: the table may have been switched off or the tournament ended while people waited.
  private async specOfPool(
    poolId: string,
    waiting: readonly Ticket[],
  ): Promise<PoolSpec | undefined> {
    const request = waiting[0]?.request;
    if (!request) return undefined;
    try {
      return await this.deps.directory.specOf(request);
    } catch (e) {
      // The pool stopped existing with people inside. They are told and it is emptied: leaving them
      // waiting on an impossible pairing is the worst of the answers.
      for (const ticket of waiting) {
        this.settle(ticket.playerId, (w) => w.reject(e));
        await this.deps.pool.cancel(ticket.playerId, poolId);
      }
      return undefined;
    }
  }

  // Closes out one player's wait, once and only once. Without it, a player could receive their seat
  // and then the timeout refusal.
  private settle(playerId: string, how: (waiter: Waiter) => void): void {
    const waiter = this.waiters.get(playerId);
    if (!waiter) return;
    this.waiters.delete(playerId);
    clearTimeout(waiter.timer);
    how(waiter);
  }
}
