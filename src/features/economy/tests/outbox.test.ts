import { MemoryLedger } from "@/features/economy";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { FakeWallet } from "@/tests/fake-wallet";
import { describe, expect, it, vi } from "vitest";

import { Outbox } from "../outbox";
import { InsufficientFundsError, type Movement, WalletUnavailableError } from "../wallet";

const prize: Movement = { matchId: "m1", playerId: "u1", amount: 100, reason: "PRIZE" };

// The outbox's backoff is real, so the tests run with fake timers: without them, testing the three
// attempts would cost seconds of wall clock.
async function drainWithFakeTimers(outbox: Outbox): Promise<void> {
  const drained = outbox.drain();
  await vi.runAllTimersAsync();
  await drained;
}

describe("Outbox: entrega garantizada, no fire-and-forget", () => {
  it("anota y entrega: el movimiento queda liquidado", async () => {
    vi.useFakeTimers();
    const wallet = new FakeWallet();
    const ledger = new MemoryLedger();
    const outbox = new Outbox(wallet, ledger, new MemoryLogger());

    expect(await outbox.enqueue(prize, "CREDIT")).toBe(true);
    await drainWithFakeTimers(outbox);

    expect(wallet.credited).toEqual([prize]);
    expect((await ledger.entriesOf("m1"))[0]?.status).toBe("SETTLED");
    vi.useRealTimers();
  });

  it("anotar es SÍNCRONO: el listener no espera la entrega", async () => {
    vi.useFakeTimers();
    const wallet = new FakeWallet();
    const outbox = new Outbox(wallet, new MemoryLedger(), new MemoryLogger());

    await outbox.enqueue(prize, "CREDIT");

    // Nothing has gone out yet: queueing returned before the first attempt, which is what allows
    // calling it from a synchronous listener.
    expect(wallet.credited).toEqual([]);
    vi.useRealTimers();
  });

  it("encolar dos veces lo mismo no paga dos veces", async () => {
    vi.useFakeTimers();
    const wallet = new FakeWallet();
    const outbox = new Outbox(wallet, new MemoryLedger(), new MemoryLogger());

    expect(await outbox.enqueue(prize, "CREDIT")).toBe(true);
    expect(await outbox.enqueue(prize, "CREDIT")).toBe(false); // ya estaba anotado
    await drainWithFakeTimers(outbox);

    expect(wallet.credited).toHaveLength(1);
    vi.useRealTimers();
  });

  it("reintenta cuando el otro lado está caído, y lo consigue", async () => {
    vi.useFakeTimers();
    const wallet = new FakeWallet();
    const ledger = new MemoryLedger();
    let attempts = 0;
    vi.spyOn(wallet, "credit").mockImplementation(async (m) => {
      attempts++;
      if (attempts < 3) throw new WalletUnavailableError("caído");
      wallet.credited.push(m);
    });
    const outbox = new Outbox(wallet, ledger, new MemoryLogger());

    await outbox.enqueue(prize, "CREDIT");
    await drainWithFakeTimers(outbox);

    expect(attempts).toBe(3);
    expect((await ledger.entriesOf("m1"))[0]?.status).toBe("SETTLED");
    vi.useRealTimers();
  });

  it("si nunca entra, queda FAILED — visible, no perdido (el defecto de v1)", async () => {
    vi.useFakeTimers();
    const wallet = new FakeWallet();
    const ledger = new MemoryLedger();
    wallet.setFailing(true);
    const outbox = new Outbox(wallet, ledger, new MemoryLogger());

    await outbox.enqueue(prize, "CREDIT");
    await drainWithFakeTimers(outbox);

    expect(wallet.credited).toEqual([]);
    expect((await ledger.entriesOf("m1"))[0]?.status).toBe("FAILED");
    vi.useRealTimers();
  });

  it("un fallo por saldo NO se reintenta: acreditar no le pide plata a nadie, así que es un bug", async () => {
    vi.useFakeTimers();
    const wallet = new FakeWallet();
    const ledger = new MemoryLedger();
    const credit = vi
      .spyOn(wallet, "credit")
      .mockRejectedValue(new InsufficientFundsError("la casa"));
    const outbox = new Outbox(wallet, ledger, new MemoryLogger());

    await outbox.enqueue(prize, "CREDIT");
    await drainWithFakeTimers(outbox);

    expect(credit).toHaveBeenCalledOnce();
    expect((await ledger.entriesOf("m1"))[0]?.status).toBe("FAILED");
    vi.useRealTimers();
  });
});
