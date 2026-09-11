import type { PlayerId } from "../ids.js";
import type { PlayerRepository } from "./player-repository.js";

// FACADE de mutación: redirige cada verbo al sub-player del asiento.
// Lo que esconde es la multiplicidad por asiento, no la lógica.
export class Player {
  constructor(private readonly repository: PlayerRepository) {}

  abandon(playerId: PlayerId): void {
    this.repository.get(playerId).abandon();
  }
}
