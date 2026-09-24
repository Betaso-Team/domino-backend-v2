import type { AccountDirectory, PlayerAccount } from "../accounts";
import type { Currency, RateBook } from "../rates";

// The conversion's fakes, siblings of the wallet's: in memory, always successful, and they record what
// they were asked so a test can assert on it.
//
// The default is a rate of 1, so an account unit is one dollar and a hundred cents. With that the
// catalog's amounts reach the wallet as round numbers and the tests read without mental arithmetic.

export class FakeAccountDirectory implements AccountDirectory {
  private readonly byPlayer = new Map<string, PlayerAccount>();
  readonly asked: string[] = [];

  constructor(private readonly fallback: Currency = "USD") {}

  setAccount(playerId: string, account: Partial<PlayerAccount>): void {
    this.byPlayer.set(playerId, { ...this.defaultFor(playerId), ...account });
  }

  async accountOf(playerId: string): Promise<PlayerAccount> {
    this.asked.push(playerId);
    return this.byPlayer.get(playerId) ?? this.defaultFor(playerId);
  }

  private defaultFor(playerId: string): PlayerAccount {
    return { currency: this.fallback, username: playerId, profilePicture: "" };
  }
}

export class FakeRateBook implements RateBook {
  private readonly byCurrency = new Map<Currency, number>();
  readonly asked: Currency[] = [];

  constructor(private readonly fallback = 1) {}

  setRate(currency: Currency, rate: number): void {
    this.byCurrency.set(currency, rate);
  }

  async rateFor(currency: Currency): Promise<number> {
    this.asked.push(currency);
    return this.byCurrency.get(currency) ?? this.fallback;
  }
}
