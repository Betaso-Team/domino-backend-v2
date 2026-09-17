import type { Command, CommandPayload } from "../command";
import type { Driver } from "../engine/driver";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

export class PassCommand implements Command<"PASS", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly matchDriver: Driver,
  ) {}

  execute({ playerId }: CommandPayload<"PASS">): readonly MatchEvent[] {
    this.referee.assertCanPass(playerId);
    return this.matchDriver.advance(playerId, "PASSED").events;
  }
}
