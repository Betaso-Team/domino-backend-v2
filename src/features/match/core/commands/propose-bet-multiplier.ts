import type { Command, CommandPayload } from "../command";
import type { BetNegotiation, BetReferee } from "../engine/bet/index";
import type { RoundDriver } from "../engine/round/driver";
import type { MatchEvent } from "../events";

// PROPONER UN AUMENTO DE APUESTA. No emite evento: el comando ya es el registro de lo que
// pasó, y lo que provoca —la ronda congelada, la oferta en el árbol— se lee del estado.
//
// El orden es guarda, dato, transición, y no es intercambiable: la oferta tiene que EXISTIR
// antes de congelar, porque es la oferta la que guarda el reloj del turno que el congelado
// pisa.
export class ProposeBetMultiplierCommand implements Command<"PROPOSE_BET_MULTIPLIER", MatchEvent> {
  constructor(
    private readonly betReferee: BetReferee,
    private readonly bet: BetNegotiation,
    private readonly roundDriver: RoundDriver,
  ) {}

  execute({ playerId, level }: CommandPayload<"PROPOSE_BET_MULTIPLIER">): readonly MatchEvent[] {
    // YA NO LLAMA AL JUEZ DE LA PARTIDA: "¿sigue jugando?" es la primera guarda de
    // `canProposeBet`, así que pedirla aparte era la misma pregunta hecha dos veces desde dos
    // actores — y el orden entre las dos era invisible desde acá.
    //
    // Devuelve el nivel además de juzgarlo: los números los pone el SERVIDOR, y buscarlos dos
    // veces dejaría abierta la puerta a que la guarda mire un nivel y el efecto aplique otro.
    const option = this.betReferee.assertCanPropose(playerId, level);
    this.bet.open(playerId, option, 0);
    this.roundDriver.freezeForBet();
    return [];
  }
}
