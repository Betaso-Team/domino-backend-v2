import { type InternalApiKey, internalAuthHeaders } from "@/features/auth";
import type { HttpClient } from "@/shared/http";
import {
  type TournamentClient,
  type TournamentInfo,
  type TournamentStatus,
  TournamentUnavailableError,
} from "../client";
import type { TournamentConfig } from "../config";

// THE TOURNAMENT, against the main backend that owns it. Two calls and two different credentials,
// and the distinction runs deep:
//
//   infoOf      the server's internal key  → "what do you know about this tournament?", asked by the
//                                            truco
//   isEnrolled  the player's bearer token  → "is THIS one connecting enrolled?", asked by them
//
// Answering the second with server credentials would turn it into "is someone with this id
// enrolled?", which is not the same and not what has to be authorised.

const BASE = "championship/championships";

// The backend returns the WHOLE tournament document. Only what the truco looks at is declared here,
// and all of it optional: what is missing is detected and said, instead of breaking with an
// `undefined` three layers up.
interface ChampionshipResponse {
  readonly name?: string;
  readonly status?: string;
  readonly gameConfig?: { readonly modality?: string };
  readonly scoringConfig?: { readonly pointsPerLoss?: number };
}

// The state travels lowercase with underscores and on this side the vocabulary is uppercase, like
// every other union in the repo. The translation is ONE line and lives here, at the boundary: letting
// the foreign spelling in would force the tournament pool to compare against a backend literal.
const STATUSES: Readonly<Record<string, TournamentStatus>> = {
  scheduled: "SCHEDULED",
  in_registration: "IN_REGISTRATION",
  in_game: "IN_GAME",
  finished: "FINISHED",
  paid: "PAID",
  canceled: "CANCELED",
};

// HOW MANY SIT DOWN. The backend serves no field with this; it serves the MODALITY, which is the same
// concept said another way and works perfectly.
//
// An all-against-all modality exists in the panel and is not a truco match: it is refused rather than
// seating two and hoping it works out. The tournament exists, but this server cannot host it.
const SEATS: Readonly<Record<string, number>> = { "1vs1": 2, "2vs2": 4 };

export class HttpTournamentClient implements TournamentClient {
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: InternalApiKey,
    private readonly config: TournamentConfig,
  ) {}

  async infoOf(tournamentId: string): Promise<TournamentInfo> {
    let response: ChampionshipResponse;
    try {
      response = await this.http.get<ChampionshipResponse>(
        `${BASE}/${tournamentId}`,
        internalAuthHeaders(this.apiKey),
      );
    } catch (e) {
      // It does not exist, or it did not answer. Both are "could not be played here" and both fall
      // into the same error: what matchmaking needs to tell apart is this from "exists but is not in
      // play", and that is decided by the status and not by the transport.
      throw new TournamentUnavailableError(`${tournamentId}: ${String(e)}`);
    }

    const status = STATUSES[response?.status ?? ""];
    if (!status) throw new TournamentUnavailableError(`${tournamentId}: estado desconocido`);
    const seats = SEATS[response.gameConfig?.modality ?? ""];
    if (!seats) throw new TournamentUnavailableError(`${tournamentId}: modalidad no jugable`);
    const pointsToWin = this.config.pointsToWinBySeats[seats];
    if (!pointsToWin)
      throw new TournamentUnavailableError(`${tournamentId}: sin puntaje para ${seats}`);

    return {
      status,
      name: response.name ?? "",
      // The ONLY thing that comes out of the tournament as-is. Without it the loser adds nothing,
      // which is no reason not to play.
      pointsPerLoss: response.scoringConfig?.pointsPerLoss ?? 0,
      playersQuantity: seats,
      pointsToWin,
    };
  }

  async isEnrolled(tournamentId: string, playerToken: string): Promise<boolean> {
    try {
      const response = await this.http.get<{ enrolled?: boolean }>(
        `${BASE}/${tournamentId}/is-enrolled`,
        { authorization: `Bearer ${playerToken}` },
      );
      return response?.enrolled === true;
    } catch (e) {
      // It does NOT degrade to `false`: "could not be asked" and "not enrolled" have different
      // consequences — one invites a retry and the other does not.
      throw new TournamentUnavailableError(`${tournamentId}: ${String(e)}`);
    }
  }
}
