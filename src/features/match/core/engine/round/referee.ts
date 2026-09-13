import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import type { BoardSide, TileLike } from "../../state/tile.js";
import { RuleViolationError } from "../errors.js";
import {
  boneyardCountOf,
  currentRoundOf,
  currentTurnOf,
  handOf,
  playerOf,
  roundActivePlayers,
} from "../state-projections.js";
import { sameTile } from "../tile-set.js";
import { boardEndsOf } from "./board-ends.js";
import { hasPlayableTile, playableSides } from "./playable.js";

// JUEZ de la RONDA. Read-only: valida y deriva, no muta.
export class RoundReferee {
  constructor(private readonly match: MatchState) {}

  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.assertIsTurn(playerId);
    const held = this.tileInHand(playerId, tile);
    if (!held) throw new RuleViolationError("TILE_NOT_IN_HAND");
    const ends = boardEndsOf(currentRoundOf(this.match).board);
    if (!playableSides(tile, ends).includes(side)) {
      throw new RuleViolationError("SIDE_NOT_PLAYABLE");
    }
  }

  assertCanDraw(playerId: PlayerId): void {
    this.assertIsTurn(playerId);
    const round = currentRoundOf(this.match);
    if (this.hasPlayable(playerId)) {
      throw new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING");
    }
    if (boneyardCountOf(round) === 0) throw new RuleViolationError("BONEYARD_EMPTY");
  }

  assertCanPass(playerId: PlayerId): void {
    this.assertIsTurn(playerId);
    const round = currentRoundOf(this.match);
    if (this.hasPlayable(playerId)) {
      throw new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING");
    }
    if (boneyardCountOf(round) > 0) {
      throw new RuleViolationError("MUST_DRAW_INSTEAD_OF_PASSING");
    }
  }

  assertCanRevealTiles(playerId: PlayerId): void {
    if (currentRoundOf(this.match).phase !== "DEALING") {
      throw new RuleViolationError("NOT_DEALING");
    }
    if (playerOf(playerId, this.match).hasSeenTiles) {
      throw new RuleViolationError("TILES_ALREADY_SEEN");
    }
  }

  playersWithoutTilesSeen(): readonly PlayerId[] {
    return roundActivePlayers(this.match)
      .filter((player) => !player.hasSeenTiles)
      .map((player) => player.playerId);
  }

  hasPlayable(playerId: PlayerId): boolean {
    const ends = boardEndsOf(currentRoundOf(this.match).board);
    return hasPlayableTile([...handOf(playerId, this.match).tiles], ends);
  }

  tileInHand(playerId: PlayerId, tile: TileLike): TileLike | undefined {
    return [...handOf(playerId, this.match).tiles].find((held) => sameTile(held, tile));
  }

  private assertIsTurn(playerId: PlayerId): void {
    const round = currentRoundOf(this.match);
    if (round.phase !== "PLAYING") throw new RuleViolationError("NOT_PLAYING");
    if (currentTurnOf(round).playerId !== playerId) {
      throw new RuleViolationError("NOT_YOUR_TURN");
    }
  }
}
