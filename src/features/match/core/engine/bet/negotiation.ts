import type { BetLevel } from "../../config";
import type { PlayerId } from "../../ids";
import type { MatchState } from "../../state";
import { BetOffer } from "../../state/round";
import { currentRoundOf } from "../state-projections";

// EL DUEÑO DEL DATO del aumento: la oferta viva y lo acordado. **No decide transiciones ni
// arma plazos** —eso es del conductor de RONDA, que es el dueño de la máquina de fases— y no
// juzga nada —eso es del `BetReferee`—. Es la forma más chica que toma la convención de
// actores acá: sin conductor y sin servicios, porque las cuatro puntas de esta negociación
// son actos de jugador y el vencimiento ya tiene quién lo conduzca.
// Lo que quedó de la negociación al cerrarla, que es justamente lo que deja de poder
// consultarse: `settle` borra la oferta.
export interface BetSettlement {
  readonly accepted: boolean;
  readonly turnRemainingMs: number;
  /**
   * LO ACORDADO, devuelto porque `settle` es lo que lo borra. Quien cobra lo necesita y ya no
   * puede leerlo del árbol: la oferta muere en el mismo acto que cierra el trato.
   *
   * En cero cuando no hubo trato, que es lo mismo que decir que no hay nada que cobrar.
   */
  readonly level: number;
  readonly extra: number;
  readonly additionalEntryFee: number;
}

export class BetNegotiation {
  constructor(private readonly match: MatchState) {}

  /**
   * @param additionalEntryFee cuánto le sale a cada uno aceptar. Llega CALCULADO y no sale del
   * nivel: el catálogo remoto no trae montos —no sabe cuánto cuesta esta mesa— y la cuenta es
   * `betAmountsOf`. Quien la hace es el juez, que es el único acá que tiene la config de la mesa.
   */
  open(
    proposerId: PlayerId,
    option: BetLevel,
    additionalEntryFee: number,
    turnRemainingMs: number,
  ): void {
    const offer = new BetOffer();
    offer.proposerId = proposerId;
    offer.level = option.level;
    offer.extra = option.extra;
    offer.additionalPoints = option.additionalPoints;
    offer.additionalEntryFee = additionalEntryFee;
    offer.turnRemainingMs = turnRemainingMs;
    currentRoundOf(this.match).betOffer = offer;
  }

  /** Lo que le quedaba al turno cuando esto lo congeló. Se pregunta antes de `settle`. */
  frozenTurnMs(): number {
    return currentRoundOf(this.match).betOffer?.turnRemainingMs ?? 0;
  }

  // CIERRA LA NEGOCIACIÓN, con o sin trato. Los dos caminos borran la oferta, y ése es el
  // punto de que sea UNA sola operación: una oferta que sobrevive a su respuesta es una
  // oferta que se puede contestar dos veces.
  //
  // Devuelve lo que el llamador ya no va a poder preguntar, porque esto lo borró: si hubo
  // trato, y cuánto reloj de turno había congelado la oferta.
  settle(accepted: boolean): BetSettlement {
    const round = currentRoundOf(this.match);
    const offer = round.betOffer;
    // Sin oferta no hay nada que cerrar. Es alcanzable: el plazo puede vencer en el mismo
    // tick en que entra la respuesta, y el segundo en llegar no debe aplicar nada.
    if (!offer)
      return { accepted: false, turnRemainingMs: 0, level: 0, extra: 0, additionalEntryFee: 0 };

    if (accepted) {
      // LO ACORDADO SUBE A LA PARTIDA y la oferta muere con su ronda. Es la partición del
      // modelo: la negociación es de la mano, el trato es de la mesa.
      this.match.acceptedBetExtra = offer.extra;
      this.match.acceptedBetLevel = offer.level;
    }
    const { turnRemainingMs, level, extra, additionalEntryFee } = offer;
    round.betOffer = undefined;
    return {
      accepted,
      turnRemainingMs,
      // SIEMPRE los números de la oferta, aceptada o no. Devolver ceros al rechazar obligaría a
      // quien llama a mirar dos campos para saber si hay algo que hacer, y el que registra el
      // rechazo quiere saber QUÉ se rechazó.
      level,
      extra,
      additionalEntryFee,
    };
  }

  /**
   * DESHACE EL TRATO YA ASENTADO, y es lo único de esta clase que no lo pide un jugador.
   *
   * Lo pide la RED cuando el cobro no salió: el motor es SÍNCRONO por contrato, así que asienta
   * el aumento sin esperar a la billetera y la compensación llega después. Sin esto, un cobro
   * fallido dejaría la mesa diciendo x5 para siempre — y el cierre pagaría un premio con dinero
   * que nunca entró.
   *
   * @returns el nivel que se deshizo, o `0` si no había nada acordado. Es idempotente: dos
   * compensaciones sobre el mismo trato no dejan el escalar en negativo ni emiten dos eventos.
   */
  revoke(): number {
    const level = this.match.acceptedBetLevel;
    if (level === 0) return 0;
    this.match.acceptedBetExtra = 0;
    this.match.acceptedBetLevel = 0;
    return level;
  }

  // Quién está esperando contestar. Lo necesita el reloj para poder decir en nombre de quién
  // rechazó, y se pregunta ANTES de `settle`, que es lo que borra la oferta.
  pendingRespondent(respondentOf: (proposerId: PlayerId) => PlayerId): PlayerId | undefined {
    const offer = currentRoundOf(this.match).betOffer;
    return offer ? respondentOf(offer.proposerId) : undefined;
  }
}
