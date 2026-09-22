import type { Command, CommandPayload } from "../command";
import type { MatchDriver } from "../engine/match/driver";
import type { RematchReferee } from "../engine/rematch/referee";
import type { MatchEvent } from "../events";

// PEDIR LA REVANCHA. No emite evento propio —el comando ES el registro de que alguien la pidió,
// que es el criterio de §5.1— y devuelve lo que el conductor produzca, que es vacío salvo en un
// caso: cuando este mismo verbo llega segundo y cierra el acuerdo.
//
// ⚠ EL MISMO VERBO TIENE DOS EFECTOS SEGÚN CUÁNDO LLEGUE, y no es un accidente del `if`: con los
// dos jugadores apretando «Revancha» en el mismo segundo, el segundo cuenta como aceptación. Es
// la regla de v1 y está argumentada en `rules/rematch.ts`; el ruteo vive en el CONDUCTOR porque
// es una transición y no una legalidad, y por eso este comando no lo decide ni lo sabe.
//
// LA GUARDA ES UNA SOLA porque `canRequestRematch` ya pregunta todo: que haya ventana, que no
// haya otra solicitud, que el que habla esté sentado y que quede contra quién jugar.
export class RequestRematchCommand implements Command<"REQUEST_REMATCH", MatchEvent> {
  constructor(
    private readonly referee: RematchReferee,
    private readonly driver: MatchDriver,
  ) {}

  execute({ playerId }: CommandPayload<"REQUEST_REMATCH">): readonly MatchEvent[] {
    this.referee.assertCanRequest(playerId);
    return this.driver.requestRematch(playerId).events;
  }
}
