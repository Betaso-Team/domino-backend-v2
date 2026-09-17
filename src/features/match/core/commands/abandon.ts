import type { Command, CommandPayload } from "../command";
import type { Driver } from "../engine/driver";
import type { Player } from "../engine/player-facade";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

// No emite evento: el comando ya registra el acto. ABANDON como evento queda
// reservado para el retiro ejecutado por el sistema al vencer un plazo.
export class AbandonCommand implements Command<"ABANDON", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: Driver,
  ) {}

  execute({ playerId }: CommandPayload<"ABANDON">): readonly MatchEvent[] {
    this.referee.assertCanAbandon(playerId);
    this.players.abandon(playerId);
    return this.matchDriver.advance(playerId, "ABANDONED").events;
  }
}
