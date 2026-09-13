import type { PlayerId } from "../ids.js";
import type { BoardSide, TileLike } from "../state/tile.js";
import type { MatchReferee } from "./match/referee.js";
import type { RoundReferee } from "./round/referee.js";

// FACADE solo-juez: agrega los assertCanX en una superficie. Read-only.
export class Referee {
  constructor(
    private readonly matchReferee: MatchReferee,
    private readonly roundReferee: RoundReferee,
  ) {}

  assertCanAbandon(playerId: PlayerId): void {
    this.matchReferee.assertCanAbandon(playerId);
  }

  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanPlay(playerId, tile, side);
  }

  assertCanDraw(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanDraw(playerId);
  }

  assertCanPass(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanPass(playerId);
  }

  assertCanRevealTiles(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanRevealTiles(playerId);
  }
}
