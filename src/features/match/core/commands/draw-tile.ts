import type { Command, CommandPayload } from "../command.js";
import type { Driver } from "../engine/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";
import type { MatchEvent } from "../events.js";

export class DrawTileCommand implements Command<"DRAW_TILE", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: Driver,
  ) {}

  execute({ playerId }: CommandPayload<"DRAW_TILE">): readonly MatchEvent[] {
    this.referee.assertCanDraw(playerId);
    this.players.drawTile(playerId);
    return this.matchDriver.advance(playerId, "DREW").events;
  }
}
