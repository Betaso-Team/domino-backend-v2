import type { Command, CommandPayload } from "../command.js";
import type { Driver } from "../engine/driver.js";
import type { Referee } from "../engine/referee-facade.js";
import type { MatchEvent } from "../events.js";

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
