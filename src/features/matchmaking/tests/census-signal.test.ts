import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { type LiveCensus, type MatchCensus, PolledCensus } from "../live-matches";

// A source that COUNTS how often it was asked, which is the whole point of putting a poll in front of
// it: the cost has to stop depending on how many are asking.
class CountingCensus implements MatchCensus {
  reads = 0;
  failing = false;
  playersInMatch = 0;

  async count(): Promise<LiveCensus> {
    this.reads += 1;
    if (this.failing) throw new Error("el store no contesta");
    return { playersInMatch: this.playersInMatch, byGameMode: new Map([["libre", 2]]) };
  }
}

const polled = (source: MatchCensus) =>
  new PolledCensus({ source, intervalMs: 60_000, log: new MemoryLogger() });

describe("PolledCensus", () => {
  it("nace en cero sin haber preguntado nada", () => {
    const source = new CountingCensus();

    const census = polled(source);

    expect(census.current()).toEqual({ playersInMatch: 0, byGameMode: new Map() });
    expect(source.reads).toBe(0);
  });

  it("después de una pasada contesta lo que contó", async () => {
    const source = new CountingCensus();
    source.playersInMatch = 42;
    const census = polled(source);

    await census.check();

    expect(census.current().playersInMatch).toBe(42);
    expect(census.current().byGameMode.get("libre")).toBe(2);
  });

  // The reason this exists: the lobby counts every five seconds and the endpoint takes no credential,
  // so without this every visitor would be one more walk of the cluster's census — and a walk that
  // WRITES, since it sweeps the rooms that died.
  it("cien preguntas cuestan una sola lectura", async () => {
    const source = new CountingCensus();
    const census = polled(source);
    await census.check();

    for (let i = 0; i < 100; i++) {
      census.current();
      await census.count();
    }

    expect(source.reads).toBe(1);
  });

  // Whoever already counted through the port goes on counting and finds it free: that is what keeps
  // the lobby from having to change.
  it("sigue siendo un censo: `count()` contesta lo mismo que `current()`", async () => {
    const source = new CountingCensus();
    source.playersInMatch = 7;
    const census = polled(source);
    await census.check();

    expect(await census.count()).toEqual(census.current());
  });

  it("si el store falla, se queda con el último número bueno", async () => {
    const source = new CountingCensus();
    source.playersInMatch = 9;
    const census = polled(source);
    await census.check();

    source.failing = true;
    await census.check();

    expect(census.current().playersInMatch).toBe(9);
  });

  // A first pass that fails leaves zeroes, which is the honest answer to "I do not know yet" and the
  // one that breaks a banner the least.
  it("si falla la primera, queda en cero y no explota", async () => {
    const source = new CountingCensus();
    source.failing = true;
    const census = polled(source);

    await expect(census.check()).resolves.toBeUndefined();

    expect(census.current().playersInMatch).toBe(0);
  });

  it("arrancar cuenta de una, sin esperar el intervalo", async () => {
    const source = new CountingCensus();
    source.playersInMatch = 3;
    const census = polled(source);

    census.start();
    await census.check();
    census.stop();

    expect(census.current().playersInMatch).toBe(3);
  });
});
