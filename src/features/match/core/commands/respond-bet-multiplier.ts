import type { Command, CommandPayload } from "../command";
import type { BetNegotiation, BetReferee } from "../engine/bet";
import type { RoundDriver } from "../engine/round/driver";
import type { MatchEvent } from "../events";

// CONTESTAR UN AUMENTO DE APUESTA. Tampoco emite evento —el comando registra el sí o el no—,
// a diferencia del rechazo que dicta el reloj, que sí lo emite porque detrás de aquél no hay
// ningún comando.
//
// NO COBRA, y eso es lo único grande que falta de esta feature. En v1, aceptar descuenta
// dinero real de los dos jugadores antes de aplicar el aumento, y devuelve lo cobrado si
// alguno falla. Acá el trato queda asentado y el cobro es el incremento siguiente: el motor
// es SÍNCRONO por contrato y cobrar es red, así que no puede vivir adentro de este método
// —tiene que colgarse del acuerdo ya asentado, con su compensación—. Ver `BetChargePort`.
export class RespondBetMultiplierCommand implements Command<"RESPOND_BET_MULTIPLIER", MatchEvent> {
  constructor(
    private readonly betReferee: BetReferee,
    private readonly bet: BetNegotiation,
    private readonly roundDriver: RoundDriver,
  ) {}

  execute({ playerId, accept }: CommandPayload<"RESPOND_BET_MULTIPLIER">): readonly MatchEvent[] {
    // Una sola guarda, por lo mismo que en `ProposeBetMultiplierCommand`: "¿sigue jugando?" ya
    // es la primera pregunta de `canRespondBet`.
    this.betReferee.assertCanRespond(playerId);
    // El remanente sale de acá y no del conductor porque `settle` es lo que borra la oferta:
    // preguntárselo después devolvería cero, y cero es un turno entero regalado.
    const { turnRemainingMs } = this.bet.settle(accept);
    this.roundDriver.resumeFromBet(turnRemainingMs);
    return [];
  }
}
