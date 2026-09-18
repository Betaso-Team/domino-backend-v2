import type { Command, CommandPayload } from "../command";
import type { Driver } from "../engine/driver";
import type { MoveLog } from "../engine/move-log";
import type { Player } from "../engine/player-facade";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

export class DrawTileCommand implements Command<"DRAW_TILE", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: Driver,
    private readonly moves: MoveLog,
  ) {}

  execute({ playerId }: CommandPayload<"DRAW_TILE">): readonly MatchEvent[] {
    this.referee.assertCanDraw(playerId);
    this.moves.record("DRAW_TILE", playerId);
    this.players.drawTile(playerId);
    return this.matchDriver.advance(playerId, "DREW").events;
  }
}
