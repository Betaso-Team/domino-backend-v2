import { FakeRateBook } from "@/features/economy/tests/fake-accounts";
import { describe, expect, it } from "vitest";
import { MatchRates } from "../match-rates";

// The freeze is CORRECTNESS and not auditing: the entry is charged at admission and the prize paid
// minutes later, and if the rate moves in between the prize stops being the multiple the player saw.
// These tests pin the two properties that make it true.
describe("MatchRates", () => {
  it("la primera conversión de una partida fija la tasa, y las demás la reusan", async () => {
    const rates = new FakeRateBook(40);
    const matchRates = new MatchRates(rates);

    const atCharge = await matchRates.rateFor("room-1", "VES");
    rates.setRate("VES", 44); // el mercado se mueve durante la partida
    const atPayout = await matchRates.rateFor("room-1", "VES");

    expect(atCharge).toBe(40);
    expect(atPayout).toBe(40);
    // And it is not asked again: one query per (match, currency).
    expect(rates.asked).toEqual(["VES"]);
  });

  // At one table each player can be in their own currency, so "the match's rate" would mean nothing:
  // one is frozen per currency.
  it("congela por (partida, moneda), no por partida", async () => {
    const rates = new FakeRateBook(1);
    rates.setRate("VES", 40);
    rates.setRate("USD", 1);
    const matchRates = new MatchRates(rates);

    expect(await matchRates.rateFor("room-1", "VES")).toBe(40);
    expect(await matchRates.rateFor("room-1", "USD")).toBe(1);
    expect(rates.asked).toEqual(["VES", "USD"]);
  });

  it("dos partidas no comparten el congelado", async () => {
    const rates = new FakeRateBook(40);
    const matchRates = new MatchRates(rates);

    await matchRates.rateFor("room-1", "VES");
    rates.setRate("VES", 44);

    // Whichever starts later takes TODAY's rate, which is correct: its player has not paid yet.
    expect(await matchRates.rateFor("room-2", "VES")).toBe(44);
    expect(await matchRates.rateFor("room-1", "VES")).toBe(40);
  });

  // Both players entering at once wait on the same answer and have to see the same number: if each
  // froze their own, one would pay at one rate and the other at another at the same table.
  it("dos cobros simultáneos de la misma partida congelan el mismo número", async () => {
    const rates = new FakeRateBook(40);
    const matchRates = new MatchRates(rates);

    const [a, b] = await Promise.all([
      matchRates.rateFor("room-1", "VES"),
      matchRates.rateFor("room-1", "VES"),
    ]);

    expect(a).toBe(b);
  });
});
