import type { PlayerId } from "../../ids";
import {
  canDrawTile,
  canPass,
  canPlayTile,
  canRevealTiles,
  hasPlayable,
  playersWithoutTilesSeen,
} from "../../rules/legality";
import { tileInHand } from "../../rules/projections";
import type { TileLike } from "../../rules/tiles";
import type { MatchView } from "../../rules/view";
import type { MatchState } from "../../state/index";
import type { BoardSide } from "../../state/tile";
import { SchemaMatchView } from "../../state/view";
import { assertLegal } from "../errors";

// JUEZ de la RONDA. Read-only: valida y deriva, no muta.
//
// YA NO DECIDE NADA, y eso es todo lo que cambió: la decisión vive en `rules/legality.js`, que
// dictamina en vez de lanzar. Acá quedó el MECANISMO —leer el veredicto y cortar el comando— más
// las dos derivaciones que el conductor le pregunta. Es lo que deja que la misma regla la corra
// el cliente para apagar un botón, sin un `try/catch` y sin copiarla.
export class RoundReferee {
  private readonly view: MatchView;

  constructor(match: MatchState) {
    this.view = new SchemaMatchView(match);
  }

  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    assertLegal(canPlayTile(playerId, tile, side, this.view));
  }

  assertCanDraw(playerId: PlayerId): void {
    assertLegal(canDrawTile(playerId, this.view));
  }

  assertCanPass(playerId: PlayerId): void {
    assertLegal(canPass(playerId, this.view));
  }

  assertCanRevealTiles(playerId: PlayerId): void {
    assertLegal(canRevealTiles(playerId, this.view));
  }

  playersWithoutTilesSeen(): readonly PlayerId[] {
    return playersWithoutTilesSeen(this.view);
  }

  hasPlayable(playerId: PlayerId): boolean {
    return hasPlayable(playerId, this.view);
  }

  tileInHand(playerId: PlayerId, tile: TileLike): TileLike | undefined {
    return tileInHand(playerId, tile, this.view);
  }
}
