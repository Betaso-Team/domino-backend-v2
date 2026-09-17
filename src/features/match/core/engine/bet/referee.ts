import type { DominoMatchConfig } from "../../config.js";
import type { PlayerId } from "../../ids.js";
import type { BetLevel } from "../../rules/config.js";
import { betLevelOf, canProposeBet, canRespondBet } from "../../rules/legality.js";
import type { MatchView } from "../../rules/view.js";
import type { MatchState } from "../../state/index.js";
import { SchemaMatchView } from "../../state/view.js";
import { RuleViolationError, assertLegal } from "../errors.js";

// EL JUEZ DEL AUMENTO DE APUESTA. Read-only, como los otros dos: dice si se puede, nunca toca el
// estado. Los límites de v1 y el por qué de cada uno están en `rules/legality.js#canProposeBet`,
// que es quien decide; acá quedó el mecanismo.
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
  assertCanPropose(playerId: PlayerId, level: number): BetLevel {
    assertLegal(canProposeBet(playerId, level, this.view, this.config));
    const option = betLevelOf(level, this.config);
    if (!option) throw new RuleViolationError("UNKNOWN_BET_LEVEL");
    return option;
  }

  assertCanRespond(playerId: PlayerId): void {
    assertLegal(canRespondBet(playerId, this.view));
  }
}
