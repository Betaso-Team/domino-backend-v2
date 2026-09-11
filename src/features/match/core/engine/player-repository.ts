import type { PlayerId } from "../ids.js";
import { InvariantViolationError } from "./errors.js";
import type { MatchPlayer } from "./match/player.js";

// Los Player son match-bound y por ASIENTO. El repositorio los arma una vez y
// los sirve por id, así que el facade no fabrica nada en caliente.
export class PlayerRepository {
  private readonly players = new Map<PlayerId, MatchPlayer>();

  constructor(seats: readonly PlayerId[], factory: (playerId: PlayerId) => MatchPlayer) {
    for (const playerId of seats) this.players.set(playerId, factory(playerId));
  }

  get(playerId: PlayerId): MatchPlayer {
    const player = this.players.get(playerId);
    if (!player) throw new InvariantViolationError(`sin Player para ${playerId}`);
    return player;
  }
}
