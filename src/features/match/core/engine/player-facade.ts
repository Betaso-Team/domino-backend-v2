import type { PlayerId } from "../ids";
import type { BoardSide, TileLike } from "../state/tile";
import type { PlayerRepository } from "./player-repository";

// FACADE de mutación: redirige cada verbo al sub-player del asiento.
// Lo que esconde es la multiplicidad por asiento, no la lógica.
export class Player {
  constructor(private readonly repository: PlayerRepository) {}

  abandon(playerId: PlayerId): void {
    this.repository.get(playerId).abandon();
  }

  seatBot(playerId: PlayerId): void {
    this.repository.get(playerId).seatBot();
  }

  playTile(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.repository.round(playerId).playTile(tile, side);
  }

  drawTile(playerId: PlayerId): void {
    this.repository.round(playerId).drawTile();
  }

  revealTiles(playerId: PlayerId): void {
    this.repository.round(playerId).revealTiles();
  }
}
