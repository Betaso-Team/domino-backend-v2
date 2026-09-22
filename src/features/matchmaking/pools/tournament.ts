import type { DominoRoomOptions } from "@/features/match";
import {
  type StrikeBook,
  type TournamentClient,
  TournamentUnavailableError,
} from "@/features/tournament";
import { MatchmakingError } from "../errors";
import type { Ticket } from "../pool";
import type { PoolSpec, Requester } from "../pool-spec";

// The TOURNAMENT pool: the `poolId` is the tournament. Unlike the casual one this pool is CLOSED —
// only the enrolled play — and that colours everything else: towards the end only people who already
// crossed paths may be left, so the veto cannot be hardened at all.

export interface TournamentPoolDeps {
  readonly client: TournamentClient;
  // The QUESTION only. Strikes are written on the other side, in the sink; here the penalty is read.
  readonly strikes: Pick<StrikeBook, "isBlocked">;
  readonly avoid: (tournamentId: string, playerId: string) => Promise<readonly string[]>;
}

export async function tournamentPoolSpec(
  tournamentId: string,
  deps: TournamentPoolDeps,
): Promise<PoolSpec> {
  let info: Awaited<ReturnType<TournamentClient["infoOf"]>>;
  try {
    info = await deps.client.infoOf(tournamentId);
  } catch (e) {
    if (e instanceof TournamentUnavailableError) throw new MatchmakingError("POOL_NOT_FOUND");
    throw e;
  }
  // It exists but is not in play: it has not started yet, or it already closed. Told apart from "it
  // does not exist" because one invites coming back later and the other does not.
  if (info.status !== "IN_GAME") throw new MatchmakingError("POOL_CLOSED", info.status);

  return {
    poolId: tournamentId,
    // From the TOURNAMENT and not from a constant: the day the main backend serves four seats,
    // nothing changes here.
    seats: info.playersQuantity,
    pointsToWin: info.pointsToWin,

    async admit({ playerId, token }: Requester): Promise<void> {
      // The walkout penalty is charged at the queue's DOOR, the only place where it means anything:
      // inside a match there is nothing left to prevent.
      if (await deps.strikes.isBlocked(tournamentId, playerId))
        throw new MatchmakingError("PENALIZED");

      // The truco DELEGATES authorisation: the main backend rules on it, being what charged the
      // entry, and it is asked with THAT PLAYER's own token. With the server's API key the question
      // would become "is someone with this id enrolled?", which is not the same.
      let enrolled: boolean;
      try {
        enrolled = await deps.client.isEnrolled(tournamentId, token);
      } catch (e) {
        if (e instanceof TournamentUnavailableError) throw new MatchmakingError("POOL_NOT_FOUND");
        throw e;
      }
      if (!enrolled) throw new MatchmakingError("NOT_ENROLLED");
    },

    avoid: (playerId: string) => deps.avoid(tournamentId, playerId),

    toRoomOptions(group: readonly Ticket[], seed: string): DominoRoomOptions {
      return {
        mode: "TOURNAMENT",
        seats: group.map((t) => t.playerId),
        seed,
        pointsToWin: info.pointsToWin,
        tournamentId,
        pointsPerLoss: info.pointsPerLoss,
      };
    },
  };
}
