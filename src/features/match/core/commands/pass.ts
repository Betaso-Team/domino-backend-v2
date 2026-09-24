import type { Command, CommandPayload } from "../command";
import type { Driver } from "../engine/driver";
import type { MoveLog } from "../engine/move-log";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

export class PassCommand implements Command<"PASS", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly matchDriver: Driver,
    private readonly moves: MoveLog,
  ) {}

  execute({ playerId }: CommandPayload<"PASS">): readonly MatchEvent[] {
    this.referee.assertCanPass(playerId);
    this.moves.record("PASS", playerId);
    return this.matchDriver.advance(playerId, "PASSED").events;
  }
}
