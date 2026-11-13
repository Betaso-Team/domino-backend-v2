import type { Command, CommandPayload } from "../command";
import type { BetNegotiation, BetReferee } from "../engine/bet";
import type { BetTransitions } from "../engine/driver";
import type { MatchEvent } from "../events";
import type { PlayerId } from "../ids";
import type { MatchState } from "../state";

// CONTESTAR UN AUMENTO DE APUESTA. Tampoco emite evento por el «no» —el comando registra el sí o el
// no—, a diferencia del rechazo que dicta el reloj, que sí lo emite porque detrás de aquél no hay
// ningún comando.
//
// NO COBRA, Y NO PUEDE: el motor es SÍNCRONO por contrato y cobrar es red. Lo que hace con un «sí» es
// ANUNCIAR el trato con todo lo que el cobro necesita —`MULTIPLIER_AGREED`— y dejar la ronda
// congelada con la oferta aceptada. El aumento NO sube todavía: sube cuando la red confirma que los
// dos pagaron (`confirmMultiplier`), y si no pagaron la oferta se anula (`revokeMultiplier`). Así cada
// jugador recibe UNA sola respuesta: aceptado con el cobro hecho, o anulado.
//
// Antes se asentaba primero y se cobraba después, y la mesa decía x2 unos segundos antes de decir «no
// se pudo». Cobrar adentro del comando pediría un motor asíncrono, que es lo que permite que dos
// mensajes del mismo cliente se entrelacen a mitad de una mutación; congelar la ronda mientras se
// cobra da el mismo orden que v1 (cobrar, después anunciar) sin eso.
export class RespondBetMultiplierCommand implements Command<"RESPOND_BET_MULTIPLIER", MatchEvent> {
  constructor(
    private readonly betReferee: BetReferee,
    private readonly bet: BetNegotiation,
    private readonly transitions: BetTransitions,
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
    if (!accept) {
      // El remanente sale de `reject` y no del conductor porque `reject` es lo que borra la oferta:
      // preguntárselo después devolvería cero, y cero es un turno entero regalado.
      this.transitions.resumeFromBet(this.bet.reject());
      return [];
    }
    const agreement = this.bet.accept();
    if (!agreement) return [];
    this.transitions.awaitBetCharge();
    // LOS NÚMEROS SALEN DE LA OFERTA, que sigue viva: el evento los lleva porque quien cobra
    // reacciona a él y no lee el árbol. Es el mismo motivo por el que `REMATCH_ACCEPTED` lleva su
    // lista de asientos.
    return [
      {
        type: "MULTIPLIER_AGREED",
        level: agreement.level,
        extra: agreement.extra,
        additionalEntryFee: agreement.additionalEntryFee,
        playerIds: this.playerIdsOf(),
      },
    ];
  }
}
