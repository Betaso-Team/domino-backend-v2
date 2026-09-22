import type { AccountDirectory, PlayerAccount } from "./accounts";

/**
 * A match's FROZEN account. Exact sibling of `MatchRates`, and for the same reason:
 * so two moments separated in time say the same thing.
 *
 * **It is a business rule, not an optimisation.** A player enters with one currency
 * and is paid in that one, even if they switch currency in the app mid-match: what
 * was promised when charging the entry has to be honoured when paying the prize.
 * Without it, the charge and the prize of the SAME match can come out in different
 * currencies — and at the frozen rate of the other one.
 *
 * It freezes the WHOLE account and not just the currency because the name and the
 * picture travel with the prize: whoever won appears in the carousel as they were
 * called when they played.
 *
 * As in `MatchRates` there is neither invalidation NOR forgetting: invalidating
 * would be exactly what this exists to prevent, and forgetting when the room closes
 * would break the freeze, because the prize goes out through the outbox and can be
 * delivered AFTER the match died.
 *
 * **Who freezes it**: ADMISSION, the only point that holds both the match and the
 * player's TOKEN. Everything afterwards asks by (match, player) and finds the
 * answer already in place, needing no credential.
 */
export class MatchAccounts {
  private readonly frozen = new Map<string, PlayerAccount>();

  constructor(private readonly accounts: AccountDirectory) {}

  async accountOf(matchId: string, playerId: string, token?: string): Promise<PlayerAccount> {
    const key = `${matchId}:${playerId}`;
    const already = this.frozen.get(key);
    if (already) return already;
    const account = await this.accounts.accountOf(playerId, token);
    // Re-read before storing, as in `MatchRates`: two simultaneous questions about the same match
    // and player can both be waiting on the same answer.
    const winner = this.frozen.get(key);
    if (winner) return winner;
    this.frozen.set(key, account);
    return account;
  }
}
