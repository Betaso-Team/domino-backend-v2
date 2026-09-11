import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import { playerOf } from "../state-projections.js";

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
