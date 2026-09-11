import type { PlayerId } from "../ids.js";
import type { MatchReferee } from "./match/referee.js";

// FACADE solo-juez: agrega los assertCanX en una superficie. Read-only.
export class Referee {
  constructor(private readonly matchReferee: MatchReferee) {}

  assertCanAbandon(playerId: PlayerId): void {
    this.matchReferee.assertCanAbandon(playerId);
  }
}
