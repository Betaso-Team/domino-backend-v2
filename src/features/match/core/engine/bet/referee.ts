import type { BetLevel, DominoMatchConfig } from "../../config.js";
import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import { RuleViolationError } from "../errors.js";
import { currentRoundOf, roundPhaseOf } from "../state-projections.js";

// EL JUEZ DEL AUMENTO DE APUESTA. Read-only, como los otros dos: dice si se puede, nunca
// toca el estado.
//
// Los límites son los de v1 y NO son adorno de producto — cada uno tapa una forma concreta
// de sacar ventaja con dinero real:
//
//   · ventana de ≤1 ficha    proponer con la mano medio jugada es proponer sabiendo cómo
//                            viene la ronda. El aumento se ofrece cuando los dos saben lo
//                            mismo, que es al principio
//   · uno pendiente          sin esto, dos propuestas cruzadas dejan dos ofertas vivas y la
//                            respuesta no sabe a cuál contesta
//   · uno aceptado           el tope del v1. Sin él la mesa se sube sin techo a fuerza de
//                            insistir ronda a ronda
//   · mesa gratis            no hay qué aumentar, y cobrarlo sería cobrar una entrada que
//                            nadie pagó
//   · catálogo cargado       lista vacía = la mesa no ofrece aumentar. Es el reposo, porque
//                            el catálogo viene de otro repo y su falta falla CERRADO
//   · nivel del catálogo     el cliente manda un NIVEL, no un importe: los números los pone
//                            el servidor
export class BetReferee {
  constructor(
    private readonly match: MatchState,
    private readonly config: DominoMatchConfig,
  ) {}

  // QUÉ NIVEL ES, además de si se puede: quien lo pregunta necesita los números, y
  // buscarlos dos veces deja la puerta a que la guarda mire uno y el efecto aplique otro.
  // NO mira el turno, y es de v1: cualquiera de los dos puede proponer le toque o no. Que
  // el proponente siga en la partida lo comprueba `assertIsPlaying`, en el facade.
  assertCanPropose(level: number): BetLevel {
    if (this.config.isFreeRoom) throw new RuleViolationError("BETTING_DISABLED");
    if (this.config.betLevels.length === 0) throw new RuleViolationError("BETTING_DISABLED");
    if (this.match.acceptedBetLevel > 0) throw new RuleViolationError("BET_ALREADY_ACCEPTED");

    const round = currentRoundOf(this.match);
    if (round.betOffer) throw new RuleViolationError("BET_ALREADY_PENDING");
    // La ventana es de la fase de juego: en el reparto todavía no se ve nada y en la
    // presentación la ronda ya se resolvió. `NEGOTIATING_BET` lo tapa `betOffer`, arriba.
    if (roundPhaseOf(round) !== "PLAYING") throw new RuleViolationError("BET_WINDOW_CLOSED");
    // UNA FICHA, no cero: el v1 deja proponer al que abrió la ronda y al que todavía no
    // jugó. Dos ya es la mano en curso.
    if (round.board.tiles.length > 1) throw new RuleViolationError("BET_WINDOW_CLOSED");

    const found = this.config.betLevels.find((option) => option.level === level);
    if (!found) throw new RuleViolationError("UNKNOWN_BET_LEVEL");
    return found;
  }

  // Contestar es SIEMPRE legal para el que no propuso, mientras la oferta siga viva: no se
  // mira la fase —la fase ES la negociación— ni el turno. Decir que no a que te cobren de
  // más no puede depender de a quién le toca jugar.
  assertCanRespond(playerId: PlayerId): void {
    const round = currentRoundOf(this.match);
    if (!round.betOffer) throw new RuleViolationError("NO_BET_PENDING");
    if (round.betOffer.proposerId === playerId) throw new RuleViolationError("NOT_YOUR_BET");
  }
}
