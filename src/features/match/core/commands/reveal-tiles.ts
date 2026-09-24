import type { Command, CommandPayload } from "../command";
import type { Driver } from "../engine/driver";
import type { Player } from "../engine/player-facade";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

export class RevealTilesCommand implements Command<"REVEAL_TILES", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: Driver,
  ) {}

  execute({ playerId }: CommandPayload<"REVEAL_TILES">): readonly MatchEvent[] {
    this.referee.assertCanRevealTiles(playerId);
    this.players.revealTiles(playerId);
    return this.matchDriver.advance(playerId, "REVEALED").events;
  }
}
