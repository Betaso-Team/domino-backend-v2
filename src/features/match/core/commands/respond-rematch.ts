import type { Command, CommandPayload } from "../command";
import type { MatchDriver } from "../engine/match/driver";
import type { RematchReferee } from "../engine/rematch/referee";
import type { MatchEvent } from "../events";

// CONTESTAR LA SOLICITUD. Tampoco emite evento propio: el sí y el no quedan registrados como
// comando. Lo que SÍ puede devolver es `REMATCH_ACCEPTED`, que no es el eco de este verbo sino la
// consecuencia computada de que ya no falte nadie — y eso depende de quiénes seguían en la mesa,
// que no está en ningún payload.
//
// NO COBRA, y a diferencia del aumento de apuesta tampoco tiene que hacerlo: la inscripción de la
// mesa nueva la cobra esa mesa en SU puerta, con su propio `matchId`. Por eso una apertura que
// falla no tiene nada que compensar.
export class RespondRematchCommand implements Command<"RESPOND_REMATCH", MatchEvent> {
  constructor(
    private readonly referee: RematchReferee,
    private readonly driver: MatchDriver,
  ) {}

  execute({ playerId, accept }: CommandPayload<"RESPOND_REMATCH">): readonly MatchEvent[] {
    this.referee.assertCanRespond(playerId);
    return this.driver.respondRematch(playerId, accept).events;
  }
}
