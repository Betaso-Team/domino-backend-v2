import type { HttpClient } from "@/shared/http";
import { ConversionUnavailableError, type Currency, type RateBook } from "../rates";

// The rate is PUBLIC data of the backend: its route asks for no credential. It is cached with an
// expiry because it moves on its own — it is a quote — and because asking for it once per charge per
// player is where half the HTTP calls of starting a match come from.
//
// The expiry is short on purpose: what protects a player from the rate moving mid-match is the freeze
// in `MatchRates` and not this cache. This one only avoids asking the same thing again.
interface RateResponse {
  readonly rate?: number;
}

const DEFAULT_TTL_MS = 60_000;

export class HttpRateBook implements RateBook {
  private readonly cached = new Map<Currency, { rate: number; until: number }>();
  private readonly inFlight = new Map<Currency, Promise<number>>();

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async rateFor(currency: Currency): Promise<number> {
    const hit = this.cached.get(currency);
    if (hit && hit.until > this.now()) return hit.rate;

    const pending = this.inFlight.get(currency);
    if (pending) return pending;
    const request = this.fetch(currency).finally(() => this.inFlight.delete(currency));
    this.inFlight.set(currency, request);
    return request;
  }

  private async fetch(currency: Currency): Promise<number> {
    let response: RateResponse;
    try {
      response = await this.http.get<RateResponse>(`api-settings/rate/${currency}`);
    } catch (e) {
      throw new ConversionUnavailableError(`tasa de ${currency}: ${String(e)}`);
    }
    const rate = response?.rate;
    // A zero or a negative is as useless as an absence, and worse: it would charge zero. Falling
    // back to `1` is no better — in a volatile currency that is charging forty times too little.
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
      throw new ConversionUnavailableError(`tasa inválida para ${currency}: ${String(rate)}`);
    this.cached.set(currency, { rate, until: this.now() + this.ttlMs });
    return rate;
  }
}
