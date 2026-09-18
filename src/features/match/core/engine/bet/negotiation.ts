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
}

export class BetNegotiation {
  constructor(private readonly match: MatchState) {}

  open(proposerId: PlayerId, option: BetLevel, turnRemainingMs: number): void {
    const offer = new BetOffer();
    offer.proposerId = proposerId;
    offer.level = option.level;
    offer.extra = option.extra;
    offer.additionalEntryFee = option.additionalEntryFee;
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
    if (!offer) return { accepted: false, turnRemainingMs: 0 };

    if (accepted) {
      // LO ACORDADO SUBE A LA PARTIDA y la oferta muere con su ronda. Es la partición del
      // modelo: la negociación es de la mano, el trato es de la mesa.
      this.match.acceptedBetExtra = offer.extra;
      this.match.acceptedBetLevel = offer.level;
    }
    const turnRemainingMs = offer.turnRemainingMs;
    round.betOffer = undefined;
    return { accepted, turnRemainingMs };
  }

  // Quién está esperando contestar. Lo necesita el reloj para poder decir en nombre de quién
  // rechazó, y se pregunta ANTES de `settle`, que es lo que borra la oferta.
  pendingRespondent(respondentOf: (proposerId: PlayerId) => PlayerId): PlayerId | undefined {
    const offer = currentRoundOf(this.match).betOffer;
    return offer ? respondentOf(offer.proposerId) : undefined;
  }
}
