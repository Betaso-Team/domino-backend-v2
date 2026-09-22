import type { AffordQuery, Movement, WalletPort } from "../wallet";
import type { AmqpWallet } from "./amqp-wallet";
import type { HttpWallet } from "./http-wallet";

/**
 * THE REAL WALLET: one `WalletPort` assembled from both halves. All it does is
 * route, and the criterion is not technical but semantic:
 *
 *   does the operation DECIDE something?  →  HTTP, and the answer is awaited
 *   does it only have to be DELIVERED?    →  the queue, and the outbox sees it lands
 *
 * Nothing above knows there are two: admission calls `charge` and the payout
 * listener calls `credit`, exactly as against a fake.
 *
 * It has no `close()` either: the queue connection is not its own but the
 * shared publisher's, and the process's shutdown closes it. While this closed
 * it, the shutdown had to ask what kind of wallet it held to know whether there
 * was anything to close.
 */
export class BetasoWallet implements WalletPort {
  constructor(
    private readonly http: HttpWallet,
    private readonly amqp: AmqpWallet,
  ) {}

  // ── these decide: HTTP ───────────────────────────────────────────────────

  canAfford(query: AffordQuery): Promise<boolean> {
    return this.http.canAfford(query);
  }

  charge(movement: Movement): Promise<void> {
    return this.http.charge(movement);
  }

  // ── these only deliver: the queue ────────────────────────────────────────

  credit(movement: Movement): Promise<void> {
    return this.amqp.credit(movement);
  }

  refund(movement: Movement): Promise<void> {
    return this.amqp.refund(movement);
  }

  refundMatch(matchId: string, playerIds: readonly string[]): Promise<void> {
    return this.amqp.refundMatch(matchId, playerIds);
  }
}
