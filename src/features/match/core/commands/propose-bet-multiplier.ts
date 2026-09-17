import type { Command, CommandPayload } from "../command.js";
import type { BetNegotiation, BetReferee } from "../engine/bet/index.js";
import type { MatchReferee } from "../engine/match/referee.js";
import type { RoundDriver } from "../engine/round/driver.js";
import type { MatchEvent } from "../events.js";

// PROPONER UN AUMENTO DE APUESTA. No emite evento: el comando ya es el registro de lo que
// pasó, y lo que provoca —la ronda congelada, la oferta en el árbol— se lee del estado.
//
// El orden es guarda, dato, transición, y no es intercambiable: la oferta tiene que EXISTIR
// antes de congelar, porque es la oferta la que guarda el reloj del turno que el congelado
// pisa.
export class ProposeBetMultiplierCommand implements Command<"PROPOSE_BET_MULTIPLIER", MatchEvent> {
  constructor(
    private readonly matchReferee: MatchReferee,
    private readonly betReferee: BetReferee,
    private readonly bet: BetNegotiation,
    private readonly roundDriver: RoundDriver,
  ) {}

  execute({ playerId, level }: CommandPayload<"PROPOSE_BET_MULTIPLIER">): readonly MatchEvent[] {
    this.matchReferee.assertIsPlaying(playerId);
    // Devuelve el nivel además de juzgarlo: los números los pone el SERVIDOR, y buscarlos
    // dos veces dejaría abierta la puerta a que la guarda mire un nivel y el efecto aplique
    // otro.
    const option = this.betReferee.assertCanPropose(level);
    this.bet.open(playerId, option, 0);
    this.roundDriver.freezeForBet();
    return [];
  }
}
