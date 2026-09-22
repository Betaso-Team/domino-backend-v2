import type { Logger } from "@/shared/logger";

// THE MAINTENANCE SWITCH: how access to the game is cut WITHOUT A DEPLOY. It is an operational lever
// and not a feature, which is why its value does not live in the process config — that would require
// a deploy to move — but in the database product already touches.
//
// It lives in `matchmaking` and no higher because matchmaking is the ONLY door: there is no way to
// start playing that does not go through `Matchmaker.request`, so closing it there closes the game.
// What it does NOT close, on purpose, is a match in progress.

export interface Maintenance {
  readonly isUnderMaintenance: boolean;
  /** What is shown to the player. Product writes it beside the flag and it travels as-is. */
  readonly message: string;
}

/**
 * OPEN: the default, and what holds when it could not be read. That this is the
 * safe side and not the other is a decision: a database hiccup locking everyone
 * out of the game is far worse than a maintenance starting a few seconds late.
 */
export const OPEN: Maintenance = { isUnderMaintenance: false, message: "" };

/** Where the truth is read from. One `findOne` over a single-document collection. */
export interface MaintenanceBook {
  current(): Promise<Maintenance>;
}

/**
 * What the rest of the server consumes, and all anyone needs to know about
 * maintenance: how it stands NOW, and how to hear that it changed. A port separate
 * from the book on purpose — the book is *how the truth is read*, this is *how
 * everyone is kept current* — and that separation is what allows ONE database read
 * in the whole process.
 */
export interface MaintenanceSignal {
  /** No promise: the state NOW, with no network wait. */
  current(): Maintenance;
  /** @returns how to unsubscribe. */
  onChange(listener: (maintenance: Maintenance) => void): () => void;
}

/**
 * TODAY'S SIGNAL: the only thing that asks the database, and the source everyone
 * else reads from. The door alone is not enough — it refuses whoever asks, but
 * says nothing to the one already in the lobby watching the button, and does not
 * take out the one already waiting in the queue — and those two are what make a
 * maintenance show immediately instead of two minutes later.
 *
 * It is `Polled…` and not `Mongo…` because **it does not know Mongo**: it takes a
 * `MaintenanceBook`. What sets it apart from another possible signal is not where
 * it reads from — that is the book's business — but HOW it stays current: by
 * polling, because nobody pushes the change to us. The day someone does, whatever
 * goes beside it will be named after that push and not after its database.
 *
 * **One read per process per pass, and no more.** That is what the value living
 * here buys, instead of each consumer going to fetch it: without this, the door
 * would read once per match request and the public maintenance endpoint once per
 * call, meaning anyone outside could make us hammer the database in a loop. Here
 * the cost is CONSTANT: it does not depend on traffic.
 *
 * **It polls, and there is no better way.** The three alternatives all fall over:
 *
 *   · have the admin panel notify us  → touching the panel is not an option;
 *   · Mongo change streams            → they need a replica set, and the database
 *                                       is standalone;
 *   · the room-to-room channel v1      → it is Colyseus's internal channel, named
 *     publishes on                      by a room id that changes on every restart.
 *
 * **And polling is cheap, with the number measured:** a pass every 3 s is 0.33
 * reads per second, against the 4 per second a single player waiting in the queue
 * ALREADY costs. Twelve times less than what matchmaking already spends on one
 * person.
 *
 * It is per PROCESS and not per room, like the tournament watcher: a dying room
 * cannot take the notice with it. Each instance polls its own and talks to its own
 * sockets, so no leader has to be elected and nothing coordinated — and no one
 * process's failure leaves the others blind.
 */
export interface PolledMaintenanceSignalDeps {
  readonly book: MaintenanceBook;
  readonly intervalMs: number;
  readonly log: Logger;
}

export class PolledMaintenanceSignal implements MaintenanceSignal {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  // THE LAST THING SEEN. It starts OPEN for the same reason the book fails open: until it is known,
  // the game is played.
  private last: Maintenance = OPEN;
  private readonly listeners = new Set<(maintenance: Maintenance) => void>();

  constructor(private readonly deps: PolledMaintenanceSignalDeps) {}

  /**
   * The last thing seen, WITHOUT going to the database. Read by the three that
   * have to answer immediately: the door, the endpoint and the lobby's greeting.
   *
   * It can be up to one interval stale, and that is safe for a concrete reason:
   * whoever slips through that window is taken out by `closeQueues()` on the same
   * pass that detects the change.
   */
  current(): Maintenance {
    return this.last;
  }

  /**
   * @returns how to unsubscribe, and that is not ceremony: what listens is a ROOM,
   * which is born and dies many times over while the signal lives. Without it,
   * every lobby that shuts down would leave its listener attached to a process
   * that lasts hours.
   */
  onChange(listener: (maintenance: Maintenance) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timer) return;
    // The first pass goes NOW and not one interval from now: an instance coming up mid maintenance
    // has to know before it accepts anyone, not three seconds later.
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs);
    // A pending interval must not hold the process open, same as in the matcher.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** ONE pass. Public so the suite need not wait a real interval. */
  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = await this.deps.book.current();
      // CHANGES only. Without this, every pass would broadcast the same thing to every lobby socket
      // — twenty messages a minute per player — to say nothing happened.
      if (
        now.isUnderMaintenance === this.last.isUnderMaintenance &&
        now.message === this.last.message
      )
        return;
      this.last = now;
      // A low-volume fact of lasting value, which is exactly what `info` is for: the first thing one
      // wants to see when wondering why nobody could get in to play.
      this.deps.log.info(
        now.isUnderMaintenance ? "el juego se cerró por mantenimiento" : "el juego volvió a abrir",
        { isUnderMaintenance: now.isUnderMaintenance },
      );
      for (const listener of this.listeners) {
        // Each listener in its own try: one that blows up cannot leave the others unnotified — and
        // the others are the lobby next door and the emptying of the queues.
        try {
          listener(now);
        } catch (e) {
          this.deps.log.error("un oyente del mantenimiento falló", { err: e });
        }
      }
    } catch (e) {
      // This should not be reachable: the book already fails open on its own. It is caught anyway so
      // an unexpected failure does not take the interval with it and leave the process blind.
      this.deps.log.error("la pasada del mantenimiento falló", { err: e });
    } finally {
      this.running = false;
    }
  }
}
