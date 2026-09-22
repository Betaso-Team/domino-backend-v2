import type { PlayerId } from "../../ids";
import { canRequestRematch, canRespondRematch } from "../../rules/rematch";
import type { MatchView } from "../../rules/view";
import type { MatchState } from "../../state";
import { SchemaMatchView } from "../../state/view";
import { assertLegal } from "../errors";

// EL JUEZ DE LA REVANCHA. Read-only como los otros tres: dice si se puede, nunca toca el estado.
// Quien decide es `rules/rematch.ts`; acá quedó el mecanismo de convertir el veredicto en la
// excepción que aborta el comando.
//
// NO RECIBE LA CONFIG, y es la diferencia con `BetReferee`: las reglas de la revancha no miran
// un solo número de la mesa. Si esta mesa ofrece revancha ya se decidió al abrir la ventana —o
// no se abrió—, y si estos dos pueden pagarla vive en `eligible`, que ninguna regla ve.
export class RematchReferee {
  private readonly view: MatchView;

  constructor(match: MatchState) {
    this.view = new SchemaMatchView(match);
  }

  assertCanRequest(playerId: PlayerId): void {
    assertLegal(canRequestRematch(playerId, this.view));
  }

  assertCanRespond(playerId: PlayerId): void {
    assertLegal(canRespondRematch(playerId, this.view));
  }
}
