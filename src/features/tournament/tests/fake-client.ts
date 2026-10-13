// EL CLIENTE DE TORNEOS FALSO de la suite del torneo.

import { type TournamentClient, type TournamentInfo, TournamentUnavailableError } from "../client";

// THE TOURNAMENT BACKEND, IN MEMORY: the tournaments and the enrolments are loaded by hand, and it
// can be switched off to test the sad path.

export class FakeTournamentClient implements TournamentClient {
  private readonly tournaments = new Map<string, TournamentInfo>();
  private readonly enrolled = new Set<string>();
  // The backend down. Same name and semantics as the repo's other fakes: the failure LASTS until it
  // is reverted, it is not single-use.
  private failing = false;

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  setInfo(tournamentId: string, info: TournamentInfo): void {
    this.tournaments.set(tournamentId, info);
  }

  enroll(tournamentId: string, playerToken: string): void {
    this.enrolled.add(`${tournamentId}:${playerToken}`);
  }

  async infoOf(tournamentId: string): Promise<TournamentInfo> {
    if (this.failing) throw new TournamentUnavailableError(tournamentId);
    const info = this.tournaments.get(tournamentId);
    if (!info) throw new TournamentUnavailableError(tournamentId);
    return info;
  }

  async isEnrolled(tournamentId: string, playerToken: string): Promise<boolean> {
    if (this.failing) throw new TournamentUnavailableError(tournamentId);
    return this.enrolled.has(`${tournamentId}:${playerToken}`);
  }
}
