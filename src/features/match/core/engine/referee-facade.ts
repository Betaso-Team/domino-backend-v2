import type { PlayerId } from "../ids";
import type { TileLike } from "../rules/tiles";
import type { BoardSide } from "../state/tile";
import type { MatchReferee } from "./match/referee";
import type { RoundReferee } from "./round/referee";

// FACADE solo-juez: agrega los assertCanX en una superficie. Read-only.
//
// YA NO COMPONE, SOLO REENVÍA, y la diferencia es dónde vive el orden de las guardas. Antes cada
// método de acá encadenaba `assertIsPlaying` con el juez de la ronda, así que la secuencia
// —y con ella qué motivo ve el jugador— estaba repartida entre este archivo y el otro. Ahora la
// secuencia completa es de `rules/legality.js`, que la declara una vez por verbo y la deja
// probar sin pasar por dos actores.
export class Referee {
  constructor(
    private readonly matchReferee: MatchReferee,
    private readonly roundReferee: RoundReferee,
  ) {}

  assertCanAbandon(playerId: PlayerId): void {
    this.matchReferee.assertCanAbandon(playerId);
  }

  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.roundReferee.assertCanPlay(playerId, tile, side);
  }

  assertCanDraw(playerId: PlayerId): void {
    this.roundReferee.assertCanDraw(playerId);
  }

  assertCanPass(playerId: PlayerId): void {
    this.roundReferee.assertCanPass(playerId);
  }

  assertCanRevealTiles(playerId: PlayerId): void {
    this.roundReferee.assertCanRevealTiles(playerId);
  }
}
