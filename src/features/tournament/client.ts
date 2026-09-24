// The PORT towards the main backend, which owns the tournament: it defines it, charges the entry,
// accumulates the standings and pays out. The truco is only a producer of matches, and what it needs
// to know fits in two questions.

export type TournamentStatus =
  | "SCHEDULED"
  | "IN_REGISTRATION"
  | "IN_GAME"
  | "FINISHED"
  | "PAID"
  | "CANCELED";

/**
 * The ONLY thing the truco reads off a tournament. The main backend returns the
 * whole thing — schedules, pot, prizes, currencies, modality — and none of that is
 * its business.
 *
 * `pointsPerWin` is NOT here, deliberately: the panel allows configuring it and the
 * backend serves it to the player, but the winner's score comes entirely from the
 * quality scale. Not exposing it here is what keeps someone from reading it
 * believing it does something.
 */
export interface TournamentInfo {
  readonly status: TournamentStatus;
  readonly name: string;
  /** What the loser adds. This one is static and is respected. */
  readonly pointsPerLoss: number;
  /**
   * How many sit down in each of the tournament's matches. Always 2 today, and here
   * all the same: the day a pairs tournament exists, the main backend starts
   * serving 4 and matchmaking gathers four without a line changing on this side.
   */
  readonly playersQuantity: number;
  /** To how many piedras it is played. For the same reason: it belongs to the tournament. */
  readonly pointsToWin: number;
}

/**
 * The tournament does not exist, or the backend did not answer. Told apart from
 * "exists but is not in play" because the consequences differ: one is a 404 and the
 * other a refusal with an explanation.
 */
export class TournamentUnavailableError extends Error {
  constructor(readonly tournamentId: string) {
    super(`torneo no disponible: ${tournamentId}`);
    this.name = "TournamentUnavailableError";
  }
}

export interface TournamentClient {
  /**
   * With the server's internal API key: it is the truco asking about the
   * tournament, not a player.
   *
   * @throws {TournamentUnavailableError} when it does not exist or could not be
   * asked about.
   */
  infoOf(tournamentId: string): Promise<TournamentInfo>;
  /**
   * With THAT PLAYER's own token: "you are in this tournament" is ruled on by the
   * main backend, which is what charged the entry. The truco neither infers it nor
   * caches it.
   *
   * @throws {TournamentUnavailableError} when it could not be asked. It does not
   * degrade to `false`: "could not ask" and "not enrolled" have different
   * consequences.
   */
  isEnrolled(tournamentId: string, playerToken: string): Promise<boolean>;
}
