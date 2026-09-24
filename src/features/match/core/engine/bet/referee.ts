import type { DominoMatchConfig } from "../../config";
import type { PlayerId } from "../../ids";
import type { BetLevel } from "../../rules/config";
import { betAmountsOf } from "../../rules/config";
import { betLevelOf, canProposeBet, canRespondBet } from "../../rules/legality";
import type { MatchView } from "../../rules/view";
import type { MatchState } from "../../state";
import { SchemaMatchView } from "../../state/view";
import { RuleViolationError, assertLegal } from "../errors";

// EL JUEZ DEL AUMENTO DE APUESTA. Read-only, como los otros dos: dice si se puede, nunca toca el
// estado. Los límites de v1 y el por qué de cada uno están en `rules/legality.js#canProposeBet`,
// que es quien decide; acá quedó el mecanismo.
/** El nivel juzgado MÁS lo que cuesta, que son dos cosas y se buscan una sola vez. */
export interface ProposableBet {
  readonly option: BetLevel;
  readonly additionalEntryFee: number;
}

export class BetReferee {
  private readonly view: MatchView;

  constructor(
    match: MatchState,
    private readonly config: DominoMatchConfig,
  ) {
    this.view = new SchemaMatchView(match);
  }

  // QUÉ NIVEL ES, además de si se puede: quien lo pregunta necesita los números, y buscarlos
  // dos veces deja la puerta a que la guarda mire uno y el efecto aplique otro.
  //
  // La búsqueda de abajo es el MISMO veredicto dicho dos veces —`canProposeBet` ya rechazó el
  // nivel desconocido—, y es a propósito: la alternativa es un cast que le prometa al compilador
  // algo que sólo se cumple si las dos funciones no se desincronizan nunca. Una línea muerta y
  // honesta es más barata que eso.
  assertCanPropose(playerId: PlayerId, level: number): ProposableBet {
    assertLegal(canProposeBet(playerId, level, this.view, this.config));
    const option = betLevelOf(level, this.config);
    if (!option) throw new RuleViolationError("UNKNOWN_BET_LEVEL");
    // LOS MONTOS SE CALCULAN ACÁ, y es el único lugar donde se pueden: el nivel no los trae
    // —el catálogo del backend principal no sabe cuánto cuesta esta mesa— y este juez es el
    // único actor del aumento que tiene la config congelada de la partida.
    const { additionalEntryFee } = betAmountsOf(level, this.config.entryFee, this.config.prize);
    return { option, additionalEntryFee };
  }

  assertCanRespond(playerId: PlayerId): void {
    assertLegal(canRespondBet(playerId, this.view));
  }
}
