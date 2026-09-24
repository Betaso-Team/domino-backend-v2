import type { PlayerId } from "../ids";
import { InvariantViolationError } from "./errors";
import type { MatchPlayer } from "./match/player";
import type { RoundPlayer } from "./round/player";

// Los Player son match-bound y por ASIENTO. El repositorio los arma una vez y
// los sirve por id, así que el facade no fabrica nada en caliente.
export class PlayerRepository {
  private readonly matchPlayers = new Map<PlayerId, MatchPlayer>();
  private readonly roundPlayers = new Map<PlayerId, RoundPlayer>();

  constructor(
    seats: readonly PlayerId[],
    matchFactory: (playerId: PlayerId) => MatchPlayer,
    roundFactory: (playerId: PlayerId) => RoundPlayer,
  ) {
    for (const playerId of seats) {
      this.matchPlayers.set(playerId, matchFactory(playerId));
      this.roundPlayers.set(playerId, roundFactory(playerId));
    }
  }

  get(playerId: PlayerId): MatchPlayer {
    const player = this.matchPlayers.get(playerId);
    if (!player) throw new InvariantViolationError(`sin MatchPlayer para ${playerId}`);
    return player;
  }

  round(playerId: PlayerId): RoundPlayer {
    const player = this.roundPlayers.get(playerId);
    if (!player) throw new InvariantViolationError(`sin RoundPlayer para ${playerId}`);
    return player;
  }
}
