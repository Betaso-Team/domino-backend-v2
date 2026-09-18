import type { PlayerId } from "../../ids";
import type { MatchState } from "../../state";
import { playerOf } from "../state-projections";

// ÚNICO escritor de hasAbandoned. Que sea el único es verificable con grep, y es
// lo que hace que la frontera entre actores se sostenga.
export class MatchPlayer {
  constructor(
    private readonly playerId: PlayerId,
    private readonly match: MatchState,
  ) {}

  abandon(): void {
    playerOf(this.playerId, this.match).hasAbandoned = true;
  }
}
