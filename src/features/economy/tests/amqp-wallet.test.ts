import { MemoryLedger } from "@/features/economy";
import { FakeAccountDirectory, FakeRateBook } from "@/features/economy/tests/fake-accounts";
import { type AmqpDelivery, AmqpDeliveryError } from "@/shared/amqp";
import { beforeEach, describe, expect, it } from "vitest";

import { MatchAccounts } from "../match-accounts";
import { MatchRates } from "../match-rates";
import { AmqpWallet } from "../transports/amqp-wallet";
import { WalletUnavailableError } from "../wallet";

// The pretend publisher: it records where each message went. The PLUMBING is tested in `shared/`; what
// matters here is the CONTRACT only this feature knows.
class RecordingDelivery implements AmqpDelivery {
  readonly patterns: { queue: string; pattern: string; data: unknown }[] = [];
  readonly topics: { exchange: string; routingKey: string; body: unknown }[] = [];
  private failure?: AmqpDeliveryError;

  failWith(failure: AmqpDeliveryError): void {
    this.failure = failure;
  }

  async publishPattern(queue: string, pattern: string, data: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    this.patterns.push({ queue, pattern, data });
  }

  async publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    this.topics.push({ exchange, routingKey, body });
  }
}

const betOf = (queue: RecordingDelivery) => (queue.patterns[0]?.data as { bet: number }).bet;

// What this file guards are the TWO WAYS of publishing, which the backend consumes differently:
//
//   movement → a QUEUE, with the NestJS envelope
//   refund   → a topic EXCHANGE, with a RAW payload
//
// Mixing them produces a message nobody consumes: a prize that never gets paid, silently.
describe("AmqpWallet (las dos formas de publicar)", () => {
  let accounts: FakeAccountDirectory;
  let ledger: MemoryLedger;
  let wallet: AmqpWallet;
  let queue: RecordingDelivery;

  const prize = { matchId: "room-1", playerId: "u1", amount: 1.8, reason: "PRIZE" as const };

  beforeEach(async () => {
    queue = new RecordingDelivery();
    accounts = new FakeAccountDirectory("VES");
    accounts.setAccount("u1", { currency: "VES", username: "gabriel", profilePicture: "pic.png" });
    ledger = new MemoryLedger();
    // The player paid their entry fee: it is where the prize's stake comes from.
    const entry = { matchId: "room-1", playerId: "u1", amount: 1, reason: "ENTRY_FEE" as const };
    await ledger.reserve(entry);
    await ledger.settle(entry);

    wallet = new AmqpWallet({
      publisher: queue,
      matchAccounts: new MatchAccounts(accounts),
      matchRates: new MatchRates(new FakeRateBook(40)),
      ledger,
    });
  });

  describe("credit (el premio)", () => {
    it("va a la COLA con el envoltorio de NestJS y el pattern del contrato v2", async () => {
      await wallet.credit(prize);

      expect(queue.topics).toHaveLength(0);
      expect(queue.patterns[0]?.queue).toBe("transactions_queue");
      // The v2 contract's pattern: it is what keeps the backend from writing the carousel row twice.
      expect(queue.patterns[0]?.pattern).toBe("game.movement.v2");
    });

    it("convierte a centavos y manda los tres campos que alimentan el carrusel", async () => {
      await wallet.credit(prize);

      expect(queue.patterns[0]?.data).toEqual({
        userId: "u1",
        amount: 7_200, // 1.8 UC × 40
        transactionType: "add",
        currency: "VES",
        walletType: "REAL",
        gameType: "domino",
        roomId: "room-1",
        gameMovementType: "domino",
        reason: "win",
        username: "gabriel",
        profilePicture: "pic.png",
        // What was STAKED and not the prize: the entry fee at the same rate. It is what the multiple
        // the backend shows is computed from.
        bet: 4_000,
      });
    });

    it("el `bet` suma el multiplicador cobrado, porque también es lo que puso", async () => {
      const extra = {
        matchId: "room-1",
        playerId: "u1",
        amount: 1,
        reason: "BET_MULTIPLIER" as const,
      };
      await ledger.reserve(extra);
      await ledger.settle(extra);

      await wallet.credit(prize);

      expect(betOf(queue)).toBe(8_000);
    });

    it("un cobro que FALLÓ no es una apuesta: no infla el multiplicador del ticker", async () => {
      const failed = {
        matchId: "room-1",
        playerId: "u1",
        amount: 1,
        reason: "BET_MULTIPLIER" as const,
      };
      await ledger.reserve(failed);
      await ledger.fail(failed);

      await wallet.credit(prize);

      expect(betOf(queue)).toBe(4_000);
    });

    it("un premio de cero no se publica: no hay nada que acreditar", async () => {
      await wallet.credit({ ...prize, amount: 0 });

      expect(queue.patterns).toHaveLength(0);
    });
  });

  describe("refundMatch (el reembolso de sala)", () => {
    it("va al EXCHANGE topic con payload CRUDO, sin envoltorio", async () => {
      await wallet.refundMatch("room-1", ["u1", "u2"]);

      expect(queue.patterns).toHaveLength(0);
      expect(queue.topics[0]?.exchange).toBe("betaso");
      expect(queue.topics[0]?.routingKey).toBe("wallet.game.refund");
      // It carries neither amounts nor currencies: the other side reconstructs what it charged and
      // reverses it, which is what makes it idempotent there.
      expect(queue.topics[0]?.body).toEqual({
        roomId: "room-1",
        gameType: "domino",
        userIds: ["u1", "u2"],
      });
    });

    it("sin jugadores no hay nada que devolver", async () => {
      await wallet.refundMatch("room-1", []);

      expect(queue.topics).toHaveLength(0);
    });
  });

  describe("entrega", () => {
    // This feature's outbox only understands wallets, so the queue's failure has to reach it in its
    // vocabulary and not as a `shared/` error.
    it("un fallo de la cola llega traducido, no crudo", async () => {
      queue.failWith(new AmqpDeliveryError("el broker rechazó el mensaje"));

      await expect(wallet.credit(prize)).rejects.toBeInstanceOf(WalletUnavailableError);
    });

    it("lo que se cobra por HTTP no sale por la cola", async () => {
      await expect(wallet.credit({ ...prize, reason: "ENTRY_FEE" })).rejects.toBeInstanceOf(
        WalletUnavailableError,
      );
      expect(queue.patterns).toHaveLength(0);
    });
  });
});
