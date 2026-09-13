import type { Command, CommandPayload } from "../command.js";
import type { Driver } from "../engine/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";
import type { MatchEvent } from "../events.js";

export class PlayTileCommand implements Command<"PLAY_TILE", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: Driver,
  ) {}

  execute({ playerId, left, right, side }: CommandPayload<"PLAY_TILE">): readonly MatchEvent[] {
    const tile = { left, right };
    this.referee.assertCanPlay(playerId, tile, side);
    this.players.playTile(playerId, tile, side);
    return this.matchDriver.advance(playerId, "PLAYED").events;
  }
}
