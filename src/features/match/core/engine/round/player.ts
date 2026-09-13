import type { PlayerId } from "../../ids.js";
import { type MatchState, PlacedTile } from "../../state/index.js";
import type { BoardSide, TileLike } from "../../state/tile.js";
import { InvariantViolationError } from "../errors.js";
import { boneyardOf, currentRoundOf, handOf, playerOf } from "../state-projections.js";
import { sameTile } from "../tile-set.js";
import type { SchemaVisibilityController } from "../visibility.js";

// Solo MUTA. Referee-free: la legalidad ya la comprobó el juez.
export class RoundPlayer {
  constructor(
    private readonly playerId: PlayerId,
    private readonly match: MatchState,
    private readonly visibility: SchemaVisibilityController,
  ) {}

  revealTiles(): void {
    const player = playerOf(this.playerId, this.match);
    player.hasSeenTiles = true;
    this.visibility.makePublic(player.hand.tiles, {
      kind: "PLAYER",
      playerId: this.playerId,
    });
  }

  // `hand.tiles` es el mismo nodo ronda a ronda. Ocultarlo antes de repartir evita que
  // una mano revelada a la mesa al cerrar una ronda siga pública en la siguiente.
  hideTiles(): void {
    this.visibility.hide(playerOf(this.playerId, this.match).hand.tiles, { kind: "ALL" });
  }

  playTile(tile: TileLike, side: BoardSide): void {
    const round = currentRoundOf(this.match);
    const hand = handOf(this.playerId, this.match);
    const index = [...hand.tiles].findIndex((held) => sameTile(held, tile));
    if (index < 0) throw new InvariantViolationError("la ficha no está en la mano");

    const [removed] = hand.tiles.splice(index, 1);
    if (!removed) throw new InvariantViolationError("splice no devolvió la ficha");
    hand.tileCount = hand.tiles.length;

    const placed = new PlacedTile();
    placed.tile = removed;
    placed.playedBy = this.playerId;
    placed.side = side;
    // El array conserva orden de juego; `side` permite reconstruir el orden espacial.
    round.board.tiles.push(placed);
  }

  drawTile(): void {
    const boneyard = boneyardOf(currentRoundOf(this.match));
    const [tile] = boneyard.tiles.splice(0, 1);
    if (!tile) throw new InvariantViolationError("el pozo está vacío");
    boneyard.count = boneyard.tiles.length;

    const hand = handOf(this.playerId, this.match);
    hand.tiles.push(tile);
    hand.tileCount = hand.tiles.length;
  }
}
