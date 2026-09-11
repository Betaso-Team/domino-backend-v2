import type { Command } from "../command.js";
import type { MatchDriver } from "../engine/match/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";
import type { MatchEvent } from "../events.js";

// El único verbo de PARTIDA. Delgado y en el orden de siempre:
// juez valida → player muta → conductor avanza.
//
// NO emite evento: el comando ya es el registro del acto (spec §5.1). El ABANDON
// como EVENTO existe solo cuando lo dice el sistema, que es otro camino.
export class AbandonCommand implements Command<"ABANDON", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: MatchDriver,
  ) {}

  execute({ playerId }: { playerId: string }): readonly MatchEvent[] {
    this.referee.assertCanAbandon(playerId);
    this.players.abandon(playerId);
    return this.matchDriver.advance(playerId, "ABANDONED").events;
  }
}
