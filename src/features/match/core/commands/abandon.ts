import type { Command, CommandPayload } from "../command";
import type { Retirement } from "../engine/driver";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

// No emite `ABANDON`: el comando ya registra el acto, y el evento queda reservado para el retiro
// ejecutado por el sistema al vencer un plazo. Sí puede emitir `BOT_SEATED`, y ahí no hay
// contradicción: que la mesa siga con una máquina en ese lugar no lo dice el comando ni se deriva
// de él —depende del modo y de quién más quede en el equipo del que se va—.
//
// QUIÉN DECIDE ESO NO ES ESTE COMANDO, y por eso ya no muta el asiento por su cuenta: el mismo
// retiro entra también por el reloj del turno, y con la decisión escrita en los dos lados la mesa
// se comportaría distinto según por cuál camino se fue el jugador.
export class AbandonCommand implements Command<"ABANDON", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly matchDriver: Retirement,
  ) {}

  execute({ playerId }: CommandPayload<"ABANDON">): readonly MatchEvent[] {
    this.referee.assertCanAbandon(playerId);
    return this.matchDriver.retire(playerId, false).events;
  }
}
