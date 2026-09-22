import type { PoolDirectory, PoolRequest, PoolSpec } from "../pool-spec";
import { type CasualPoolDeps, casualPoolSpec } from "./casual";
import { type TournamentPoolDeps, tournamentPoolSpec } from "./tournament";

/**
 * **The ONLY branch by mode in all of matchmaking.** The matcher, the queue, the gateway and the
 * grouping do not have one: they take a `PoolSpec` and never ask where it came
 * from.
 *
 * Adding a mode is adding a branch to the `PoolRequest` union, a function that
 * builds its spec, and one line here. The exhaustive `switch` is what makes
 * that checkable: a new branch without its case does not compile.
 */
export class ScopedPoolDirectory implements PoolDirectory {
  constructor(
    private readonly casual: CasualPoolDeps,
    private readonly tournament: TournamentPoolDeps,
  ) {}

  async specOf(request: PoolRequest): Promise<PoolSpec> {
    switch (request.kind) {
      case "CASUAL":
        return casualPoolSpec(request.gameModeId, this.casual);
      case "TOURNAMENT":
        return tournamentPoolSpec(request.tournamentId, this.tournament);
    }
  }
}
