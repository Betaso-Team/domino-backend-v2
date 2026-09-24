import type { Currency, RateBook } from "./rates";

/**
 * A match's FROZEN rate: per-process memory that exists so two moments separated in
 * time say the same thing.
 *
 * **It is correctness, not auditing.** The entry is charged at admission and the
 * prize paid at the end, with minutes in between. At the live rate the player pays
 * at one and collects at another, so the prize stops being the multiple the catalog
 * promised:
 *
 *     a table with a 1 unit entry and a 1.8 unit prize, in a volatile currency
 *     t0  charges  1   × 40 = 40      ← what they paid
 *     t1  pays     1.8 × 44 = 79.2    ← 1.98× what they paid, not 1.8×
 *     t1  pays     1.8 × 40 = 72      ← frozen: what was promised
 *
 * And it is per **(match, currency)** and not per match: at one table each player
 * can be in their own currency, so freezing "the match's rate" would mean nothing.
 *
 * The first conversion of each pair fixes it; the rest reuse it. There is neither
 * invalidation NOR forgetting, and both absences are deliberate:
 *
 *   · invalidating would be exactly what this exists to prevent;
 *   · forgetting when the room closes would break the freeze, because the prize
 *     goes out through the outbox and can be delivered AFTER the match died.
 *
 * So the map grows with every table played and dies with the process. Unlike the
 * ledger, this needs no persistence: a frozen rate is only useful while something
 * of that match is pending, and the one thing that can stay pending — a half-done
 * movement — is not retried on its own.
 */
export class MatchRates {
  private readonly frozen = new Map<string, number>();

  constructor(private readonly rates: RateBook) {}

  async rateFor(matchId: string, currency: Currency): Promise<number> {
    const key = `${matchId}:${currency}`;
    const already = this.frozen.get(key);
    if (already !== undefined) return already;
    const rate = await this.rates.rateFor(currency);
    // Re-read before storing: two simultaneous charges for the same match and currency — both
    // players entering at once — can both be waiting on the same answer. The first to arrive winning
    // rather than the last is what makes them both see the same number.
    const winner = this.frozen.get(key);
    if (winner !== undefined) return winner;
    this.frozen.set(key, rate);
    return rate;
  }
}
