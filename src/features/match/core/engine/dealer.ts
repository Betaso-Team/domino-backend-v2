import { hashSeed, mulberry32, shuffled } from "../../../../shared/rng.js";
import { type DominoMatchConfig, type GlobalDominoConfig, playerIdsOf } from "../config.js";
import { orderedTileSet } from "../rules/tiles.js";
import { Tile } from "../state/index.js";
import type { MatchState } from "../state/index.js";
import { boneyardOf, currentRoundOf, playerOf } from "./state-projections.js";

// Repartir no revela: Dealer no recibe el puerto de visibilidad. La única fuente de
// aleatoriedad se deriva de (seed, roundNumber), sin estado compartido entre rondas.
export class Dealer {
  constructor(
    private readonly match: MatchState,
    private readonly config: DominoMatchConfig,
    private readonly globalConfig: GlobalDominoConfig,
  ) {}

  deal(roundNumber: number): void {
    const round = currentRoundOf(this.match);
    const deck = shuffled(this.orderedTiles(), mulberry32(hashSeed(this.config.seed, roundNumber)));

    let cursor = 0;
    for (const playerId of playerIdsOf(this.config)) {
      const hand = playerOf(playerId, this.match).hand;
      hand.tiles.clear();
      for (let dealt = 0; dealt < this.globalConfig.tilesPerPlayer; dealt += 1) {
        const tile = deck[cursor];
        cursor += 1;
        if (!tile) break;
        hand.tiles.push(tile);
      }
      hand.tileCount = hand.tiles.length;
      hand.isRevealed = false;
    }

    if (round.boneyard) {
      const boneyard = boneyardOf(round);
      boneyard.tiles.clear();
      for (const tile of deck.slice(cursor)) boneyard.tiles.push(tile);
      boneyard.count = boneyard.tiles.length;
    }
  }

  protected orderedTiles(): Tile[] {
    return orderedTileSet().map(([left, right]) => {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      return tile;
    });
  }
}
