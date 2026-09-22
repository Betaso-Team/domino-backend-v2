import type { TournamentClient, TournamentInfo } from "../client";

/**
 * THE TOURNAMENT, CACHED, and only for whoever POLLS. Matchmaking's queue asks for
 * a tournament's state on every tick to know whether it is still in play, which
 * against the real client is four requests per second per tournament with people
 * waiting. This is what turns them into one every thirty seconds.
 *
 * **The door does not use it.** Whoever decides to seat someone reads FRESH,
 * because a tournament that closed twenty seconds ago cannot receive a new match:
 * the backend pays out when we tell it none are left, and one starting after that
 * would report with the prizes already handed out. The rule as always: what decides
 * is awaited, what polls is cached.
 *
 * `isEnrolled` passes STRAIGHT through and is never cached: an enrolment belongs to
 * a player and their credential, so storing it would be answering for someone else.
 */
export class CachedTournamentClient implements TournamentClient {
  private readonly cache = new Map<string, { info: TournamentInfo; expiresAt: number }>();
  // One request in flight per tournament: eight players queueing at once wait on the same answer
  // instead of firing eight.
  private readonly inFlight = new Map<string, Promise<TournamentInfo>>();

  constructor(
    private readonly source: TournamentClient,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  async infoOf(tournamentId: string): Promise<TournamentInfo> {
    const hit = this.cache.get(tournamentId);
    if (hit && hit.expiresAt > this.now()) return hit.info;

    const pending = this.inFlight.get(tournamentId);
    if (pending) return pending;

    // The error is NOT cached, deliberately: "it did not answer" is not a state of the tournament,
    // and storing it would keep the queue closed for thirty seconds over a network hiccup. Nor is it
    // degraded: whoever asks needs to tell "does not exist" from "exists and is not in play".
    const request = this.source
      .infoOf(tournamentId)
      .then((info) => {
        this.cache.set(tournamentId, { info, expiresAt: this.now() + this.ttlMs });
        return info;
      })
      .finally(() => this.inFlight.delete(tournamentId));

    this.inFlight.set(tournamentId, request);
    return request;
  }

  isEnrolled(tournamentId: string, playerToken: string): Promise<boolean> {
    return this.source.isEnrolled(tournamentId, playerToken);
  }
}
