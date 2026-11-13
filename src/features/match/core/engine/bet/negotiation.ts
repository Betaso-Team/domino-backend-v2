import { type Decimal, UC_DECIMALS, ZERO, decimal, fixed } from "@/shared/money";
import type { BetLevel } from "../../config";
import type { PlayerId } from "../../ids";
import type { MatchState } from "../../state";
import { BetOffer } from "../../state/round";
import { currentRoundOf } from "../state-projections";

/** Lo que el cobro de un aumento aceptado necesita, y que el evento `MULTIPLIER_AGREED` lleva. */
export interface BetAgreement {
  readonly level: number;
  readonly extra: number;
  /** En UC: lo que le cuesta a cada asiento. Cero cuando no hay nada que cobrar. */
  readonly additionalEntryFee: Decimal;
}

/** Cómo termina el cobro, visto desde la mesa: qué nivel era y cuánto reloj de turno devolver. */
export interface BetChargeOutcome {
  readonly level: number;
  readonly turnRemainingMs: number;
}

// EL DUEÑO DEL DATO del aumento: la oferta viva y lo acordado. **No decide transiciones ni
// arma plazos** —eso es del conductor de RONDA, que es el dueño de la máquina de fases— y no
// juzga nada —eso es del `BetReferee`—. Proponer y contestar son actos de jugador; el final del
// cobro (`confirm` / `drop`) lo pide la red, y el vencimiento ya tiene quién lo conduzca.
export class BetNegotiation {
  constructor(private readonly match: MatchState) {}

  /**
   * @param additionalEntryFee cuánto le sale a cada uno aceptar. Llega CALCULADO y no sale del
   * nivel: el catálogo remoto no trae montos —no sabe cuánto cuesta esta mesa— y la cuenta es
   * `betDifference`. Quien la hace es el juez, que es el único acá que tiene la config de la mesa.
   */
  open(
    proposerId: PlayerId,
    option: BetLevel,
    additionalEntryFee: Decimal,
    turnRemainingMs: number,
  ): void {
    const offer = new BetOffer();
    offer.proposerId = proposerId;
    offer.level = option.level;
    offer.extra = option.extra;
    offer.additionalPoints = option.additionalPoints;
    // EN LA CONVENCIÓN DE MONTOS, porque el estado ES el wire: texto en UC, la moneda de la mesa
    // (`"10.0000"`). El decimal rellenado y sin redondear, así que `accept` lo vuelve a leer como el
    // MISMO decimal.
    offer.additionalEntryFee = fixed(additionalEntryFee.toString(), UC_DECIMALS);
    offer.turnRemainingMs = turnRemainingMs;
    currentRoundOf(this.match).betOffer = offer;
  }

  /**
   * EL RIVAL DIJO QUE SÍ. La oferta NO se cierra: queda marcada como aceptada mientras el orquestador
   * cobra, y lo acordado no sube a la partida hasta que el cobro sale (`confirm`). Así nadie ve un
   * aumento que después se cae.
   *
   * @returns lo que el cobro necesita, o `undefined` si no había oferta que aceptar (el plazo pudo
   * vencer en el mismo tick en que entró la respuesta).
   */
  accept(): BetAgreement | undefined {
    const offer = currentRoundOf(this.match).betOffer;
    if (!offer || offer.accepted) return undefined;
    offer.accepted = true;
    return {
      level: offer.level,
      extra: offer.extra,
      // El texto que `open` escribió es el decimal con ceros a la derecha, así que vuelve idéntico.
      // Vacío no lo deja `open`; si apareciera, no hay nada que cobrar.
      additionalEntryFee: offer.additionalEntryFee ? decimal(offer.additionalEntryFee) : ZERO,
    };
  }

  /**
   * EL RIVAL DIJO QUE NO, o calló hasta que venció el plazo. Cierra la negociación sin trato.
   *
   * @returns cuánto reloj de turno había congelado la oferta, que es lo que el llamador ya no va a
   * poder preguntar: esto la borra. Cero si no había oferta pendiente de respuesta.
   */
  reject(): number {
    const round = currentRoundOf(this.match);
    const offer = round.betOffer;
    if (!offer || offer.accepted) return 0;
    round.betOffer = undefined;
    return offer.turnRemainingMs;
  }

  /** ¿Hay un aumento aceptado esperando su cobro? */
  isCharging(): boolean {
    return this.match.currentRound?.betOffer?.accepted === true;
  }

  /**
   * EL COBRO SALIÓ: los dos pagaron. Recién acá LO ACORDADO SUBE A LA PARTIDA y la oferta muere. Es la
   * partición del modelo: la negociación es de la mano, el trato es de la mesa.
   *
   * Lo pide la RED, no un jugador. Idempotente: sin un aumento aceptado esperando, no hace nada.
   */
  confirm(): BetChargeOutcome | undefined {
    const round = this.match.currentRound;
    const offer = round?.betOffer;
    if (!round || !offer?.accepted) return undefined;
    this.match.acceptedBetExtra = offer.extra;
    this.match.acceptedBetLevel = offer.level;
    round.betOffer = undefined;
    return { level: offer.level, turnRemainingMs: offer.turnRemainingMs };
  }

  /**
   * EL COBRO NO SALIÓ: la billetera dijo que no, el orquestador no contestó o no se pudo preguntar. El
   * aumento nunca llegó a la partida, así que no hay nada que deshacer en ella: se borra la oferta.
   *
   * Lo pide la RED, o el reloj si la red no contestó en todo el plazo. Idempotente: sin un aumento
   * aceptado esperando, no hace nada — y en particular no toca un aumento ya cobrado.
   */
  drop(): BetChargeOutcome | undefined {
    const round = this.match.currentRound;
    const offer = round?.betOffer;
    if (!round || !offer?.accepted) return undefined;
    round.betOffer = undefined;
    return { level: offer.level, turnRemainingMs: offer.turnRemainingMs };
  }

  // Quién está esperando contestar. Lo necesita el reloj para poder decir en nombre de quién
  // rechazó, y se pregunta ANTES de `reject`, que es lo que borra la oferta.
  pendingRespondent(respondentOf: (proposerId: PlayerId) => PlayerId): PlayerId | undefined {
    const offer = currentRoundOf(this.match).betOffer;
    return offer ? respondentOf(offer.proposerId) : undefined;
  }
}
