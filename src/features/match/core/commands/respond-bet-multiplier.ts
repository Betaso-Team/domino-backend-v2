import type { Command, CommandPayload } from "../command";
import type { BetNegotiation, BetReferee } from "../engine/bet";
import type { RoundDriver } from "../engine/round/driver";
import type { MatchEvent } from "../events";
import type { PlayerId } from "../ids";
import type { MatchState } from "../state";

// CONTESTAR UN AUMENTO DE APUESTA. Tampoco emite evento —el comando registra el sí o el no—,
// a diferencia del rechazo que dicta el reloj, que sí lo emite porque detrás de aquél no hay
// ningún comando.
//
// NO COBRA, Y NO PUEDE: el motor es SÍNCRONO por contrato y cobrar es red. Lo que hace es
// ANUNCIAR el trato con todo lo que el cobro necesita —`MULTIPLIER_AGREED`—, y la compensación
// vuelve por el otro lado (`revokeMultiplier`) si la billetera dijo que no.
//
// Ése es el orden y no al revés: asentar primero y cobrar después deja una ventana en la que el
// estado promete un premio que nadie pagó, y la compensación existe exactamente para cerrarla.
// Cobrar primero pediría un motor asíncrono, que es lo que permite que dos mensajes del mismo
// cliente se entrelacen a mitad de una mutación.
export class RespondBetMultiplierCommand implements Command<"RESPOND_BET_MULTIPLIER", MatchEvent> {
  constructor(
    private readonly betReferee: BetReferee,
    private readonly bet: BetNegotiation,
    private readonly roundDriver: RoundDriver,
    // EL ÁRBOL, y sólo para saber a quiénes alcanza el aumento. Los dos pagan lo mismo: es la
    // entrada que sube, no una apuesta contra el otro.
    private readonly match: MatchState,
  ) {}

  private playerIdsOf(): readonly PlayerId[] {
    return this.match.players.map((player) => player.playerId);
  }

  execute({ playerId, accept }: CommandPayload<"RESPOND_BET_MULTIPLIER">): readonly MatchEvent[] {
    // Una sola guarda, por lo mismo que en `ProposeBetMultiplierCommand`: "¿sigue jugando?" ya
    // es la primera pregunta de `canRespondBet`.
    this.betReferee.assertCanRespond(playerId);
    // El remanente sale de acá y no del conductor porque `settle` es lo que borra la oferta:
    // preguntárselo después devolvería cero, y cero es un turno entero regalado.
    const settlement = this.bet.settle(accept);
    this.roundDriver.resumeFromBet(settlement.turnRemainingMs);
    if (!settlement.accepted) return [];
    // LOS NÚMEROS SALEN DEL CIERRE Y NO DEL ÁRBOL, porque `settle` acaba de borrar la oferta que
    // los tenía. Es el mismo motivo por el que `REMATCH_ACCEPTED` lleva su lista de asientos.
    return [
      {
        type: "MULTIPLIER_AGREED",
        level: settlement.level,
        extra: settlement.extra,
        additionalEntryFee: settlement.additionalEntryFee,
        playerIds: this.playerIdsOf(),
      },
    ];
  }
}
