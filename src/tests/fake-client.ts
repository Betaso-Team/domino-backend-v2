// EL CLIENTE DE TORNEOS FALSO de la suite.
//
// VIVE EN `src/tests/` Y NO EN SU FEATURE, y es la Regla 4 la que lo decide: `feature-boundary`
// prohibe que una feature importe archivos internos de otra, y `features/matchmaking/tests/
// pools.test.ts` lo consume —el pool casual necesita las dos cosas para poder admitir a alguien—.
// Es el mismo motivo por el que `game-mode-catalog.ts` está acá: un archivo fuera de
// `src/features/` es el único lugar del que dos features pueden tirar.
//
// La alternativa —exportarlo por el `index.ts` de su feature, que la Regla 4 sí permite— metría
// un doble en la superficie pública, que es de donde nadie lo puede podar después.

import {
  type TournamentClient,
  type TournamentInfo,
  TournamentUnavailableError,
} from "@/features/tournament/client";

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
