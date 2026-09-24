import type { HttpClient } from "@/shared/http";
import { type AccountDirectory, AccountUnavailableError, type PlayerAccount } from "../accounts";
import { isCurrency } from "../rates";

// The player's account, against the main backend's profile route, with THEIR token. That route
// carries no module prefix, and getting it wrong degrades nothing: it 404s, the adapter cannot say
// which currency to charge in, and every table with money on it stops admitting anyone. One call
// returns the three things needed:
//
//   { currency, user: { username, profilePicture } }
interface ProfileResponse {
  readonly currency?: string;
  readonly user?: { readonly username?: string; readonly profilePicture?: string | null };
}

// Five minutes. This cache is NOT what upholds "you are paid in the currency you entered with" —
// that is `MatchAccounts`, which freezes per match and never forgets — so this one may expire: it
// only avoids asking the same thing twice in a row at the door. With an expiry, a player who switches
// currency stops dragging the old one until the next deploy, and the map stops growing forever.
const DEFAULT_TTL_MS = 5 * 60_000;

export class HttpAccountDirectory implements AccountDirectory {
  private readonly known = new Map<string, { account: PlayerAccount; until: number }>();
  // One request in flight per player: both entering at once, or the charge treading on the door's
  // heels, wait on the same answer instead of firing two.
  private readonly inFlight = new Map<string, Promise<PlayerAccount>>();

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async accountOf(playerId: string, token?: string): Promise<PlayerAccount> {
    const cached = this.known.get(playerId);
    if (cached && cached.until > this.now()) return cached.account;
    // With no token there is nobody to ask. Failing here is correct: it means someone asked before
    // the door had resolved it, and that is an ordering bug and not a value that can be guessed.
    if (!token) throw new AccountUnavailableError(`sin cuenta cacheada para ${playerId}`);

    const pending = this.inFlight.get(playerId);
    if (pending) return pending;
    const request = this.fetch(playerId, token).finally(() => this.inFlight.delete(playerId));
    this.inFlight.set(playerId, request);
    return request;
  }

  private async fetch(playerId: string, token: string): Promise<PlayerAccount> {
    let profile: ProfileResponse;
    try {
      profile = await this.http.get<ProfileResponse>("my-profile", {
        authorization: `Bearer ${token}`,
      });
    } catch (e) {
      throw new AccountUnavailableError(`perfil de ${playerId}: ${String(e)}`);
    }
    // The CURRENCY is the one thing that cannot degrade: without it there is no conversion, and
    // charging wrong is worse than not charging. The name and the picture do degrade to empty — a
    // prize with no picture is paid all the same.
    if (!isCurrency(profile?.currency))
      throw new AccountUnavailableError(`moneda desconocida para ${playerId}`);
    const account: PlayerAccount = {
      currency: profile.currency,
      username: profile.user?.username ?? "",
      profilePicture: profile.user?.profilePicture ?? "",
    };
    // The expired ones are swept when a new one is fetched: the only moment anything happens here,
    // and it keeps players who never came back from sitting in the map.
    this.forgetExpired();
    this.known.set(playerId, { account, until: this.now() + this.ttlMs });
    return account;
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [playerId, entry] of this.known) {
      if (entry.until <= now) this.known.delete(playerId);
    }
  }
}
