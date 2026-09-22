import type { Logger } from "@/shared/logger";
import { type RetryPolicy, withRetries } from "@/shared/retry";
import { newTrace, withTrace } from "@/shared/trace";
import { DuplicateMovementError, type Ledger, keyOf } from "./ledger";
import { InsufficientFundsError, type Movement, type WalletPort } from "./wallet";

// THE OUTBOX: guaranteed delivery of the movements that no longer decide anything — the prize, the
// refund. It is NOT fire-and-forget, and that distinction is the point: publishing the prize and
// assuming it landed leaves a "paid" row on one side and zero balance on the other, with no possible
// reconciliation.
//
// The split that makes it work: WRITING IT DOWN is synchronous and cannot fail, because a listener
// calls it and a listener is synchronous by contract; DELIVERING is asynchronous and retried. If the
// delivery never lands, the movement stays FAILED in the ledger — visible, not lost.

// Three attempts with a doubling wait.
const DELIVERY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500 };

export class Outbox {
  // The deliveries in flight. They exist only so they can be AWAITED, in the suite and in an ordered
  // shutdown: nothing in production watches this promise.
  private readonly inFlight = new Set<Promise<void>>();
  // What THIS process already queued. It is the immediate answer the listener needs; the authority is
  // still the ledger, which is durable.
  private readonly enqueued = new Set<string>();
  // To cut the retries short in an ordered shutdown rather than waiting them out.
  private readonly shutdown = new AbortController();

  constructor(
    private readonly wallet: WalletPort,
    private readonly ledger: Ledger,
    private readonly log: Logger,
  ) {}

  /**
   * WRITES IT DOWN and starts the delivery.
   *
   * It is SYNCHRONOUS, and this time the reason is not only that a listener calls
   * it: whether the fact is recorded depends on this answer, and a fact recorded
   * later stops being produced by the listener and starts ENTERING the notifier —
   * which would broadcast it to the client, which is exactly what money movements
   * do not do.
   *
   * So the immediate answer comes from an index of its own, in memory, while the
   * durable ledger is the authority: if it says the movement was already there,
   * nothing is delivered.
   *
   * @returns whether the movement was written down. `false` means it was already
   * there, not that anything failed.
   */
  enqueue(movement: Movement, kind: "CREDIT"): boolean {
    // The SAME key the durable ledger writes, and the same one the main backend sees the row under:
    // the identifier that lets both sides' logs be crossed without anything having been agreed.
    const key = keyOf(movement.matchId, movement.playerId, movement.reason);
    if (this.enqueued.has(key)) {
      this.log.debug("ya estaba encolado: no se entrega de nuevo", { movementKey: key });
      return false;
    }
    this.enqueued.add(key);
    // EVERY DELIVERY IS A CAUSE, opened here and not outside: the caller is a synchronous listener
    // running inside a command, and that path has none. The chain that starts — writing to the
    // ledger, calling the wallet, retrying — is what has to be followable from both sides.
    withTrace(newTrace(), () => this.track(this.reserveAndDeliver(movement, kind)));
    return true;
  }

  // The DURABLE record first, the delivery after. If the ledger says that movement was already
  // written — by another process, or by this one before it restarted — nothing is delivered.
  private async reserveAndDeliver(movement: Movement, kind: "CREDIT"): Promise<void> {
    try {
      await this.ledger.reserve(movement);
    } catch (e) {
      if (e instanceof DuplicateMovementError) return;
      throw e;
    }
    await this.deliver(movement, kind);
  }

  /** Waits for it to empty. For the suite and for the ordered shutdown, not for the normal path. */
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
    // The `.catch` is NOT one defence too many: in Node an unhandled rejection TERMINATES THE
    // PROCESS, so a `void` over a chain that can reject is a way to bring the whole server down,
    // with every other match inside it. This should never reject; if it does it is a bug, and the
    // place to find out is a log and not a dead process.
    void delivery
      .catch((e: unknown) => this.log.error("entrega con fallo no previsto", { err: e }))
      .finally(() => this.inFlight.delete(delivery));
  }

  private async deliver(movement: Movement, _kind: "CREDIT"): Promise<void> {
    // ONCE: the movement is immutable, and the key was being spelled out once per failed attempt —
    // three places to get it wrong the day its shape changes.
    const key = keyOf(movement.matchId, movement.playerId, movement.reason);
    const delivered = await withRetries(() => this.wallet.credit(movement), DELIVERY_POLICY, {
      // Crediting cannot fail over a balance — nobody is being asked for money — so if that happens
      // it is a bug on the other side and retrying does not fix it.
      isFinal: (e) => e instanceof InsufficientFundsError,
      signal: this.shutdown.signal,
      // A failed attempt with retries left is `warn` and not `error`: it can still land. The `error`
      // belongs to the end, if none of them did.
      onAttemptFailed: (err, attempt, willRetry) =>
        this.log.warn("falló un intento de entrega", {
          err,
          attempt,
          willRetry,
          movementKey: key,
        }),
    });
    if (delivered) {
      await this.ledger.settle(movement);
      this.log.info("movimiento entregado", { movementKey: key, amount: movement.amount });
    } else {
      await this.ledger.fail(movement);
      // FAILED is exactly the `error` case: something we promised not to lose did not land, and it
      // stays in the ledger waiting for someone to look at it.
      this.log.error("movimiento NO entregado", { movementKey: key, amount: movement.amount });
    }
  }
}
