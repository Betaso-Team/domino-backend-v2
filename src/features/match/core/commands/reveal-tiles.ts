import type { Command, CommandPayload } from "../command.js";
import type { Driver } from "../engine/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";
import type { MatchEvent } from "../events.js";

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
