import type { PlayerId } from "../../ids";
import type { MatchState } from "../../state";
import type { SeatExitKind } from "../../state/player";
import { playerOf } from "../state-projections";

// ÚNICO escritor de hasAbandoned, de isBot y de leftBy. Que sea el único es verificable con grep, y es
// lo que hace que la frontera entre actores se sostenga.
export class MatchPlayer {
  constructor(
    private readonly playerId: PlayerId,
    private readonly match: MatchState,
  ) {}

  abandon(how: SeatExitKind): void {
    const player = playerOf(this.playerId, this.match);
    player.hasAbandoned = true;
    player.leftBy = how;
  }

  /**
   * ESTE ASIENTO PASA A JUGARLO LA MÁQUINA, y lo único que cambia es la bandera.
   *
   * ⚠ **NO MARCA `hasAbandoned`, Y ÉSA ES LA MITAD QUE IMPORTA.** Las dos banderas dicen «acá ya
   * no hay nadie» y llevan a finales opuestos: con `hasAbandoned` el equipo pierde por forfeit y
   * el asiento sale de la rueda; con `isBot` la mesa sigue andando con ese lugar ocupado. Marcar
   * las dos daría una partida que termina por abandono con un bot jugándola.
   *
   * La mano, el equipo y el lugar en la rueda quedan donde estaban: el bot HEREDA el asiento, no
   * se sienta de cero. Es lo que hace v1 marcando sobre el mismo jugador (`on-leave.ts:112-127`),
   * y es lo que deja que la ronda en curso siga teniendo sentido — las fichas del que se fue no
   * pueden desaparecer de la mesa a mitad de mano.
   */
  seatBot(how: SeatExitKind): void {
    const player = playerOf(this.playerId, this.match);
    player.isBot = true;
    // El que dejó el asiento a la máquina también se fue, y de alguna de las dos maneras.
    player.leftBy = how;
  }
}
