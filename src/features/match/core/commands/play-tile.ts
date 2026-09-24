import type { Command, CommandPayload } from "../command";
import type { Driver } from "../engine/driver";
import type { MoveLog } from "../engine/move-log";
import type { Player } from "../engine/player-facade";
import type { Referee } from "../engine/referee-facade";
import type { MatchEvent } from "../events";

export class PlayTileCommand implements Command<"PLAY_TILE", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: Driver,
    private readonly moves: MoveLog,
  ) {}

  execute({ playerId, left, right, side }: CommandPayload<"PLAY_TILE">): readonly MatchEvent[] {
    const tile = { left, right };
    this.referee.assertCanPlay(playerId, tile, side);
    // ANTES DE MUTAR, y acá el orden es load-bearing: `advance` puede cerrar la ronda —por dominó o
    // por tranca— y abrir la siguiente, así que apuntar después mandaría la última jugada de una
    // mano al registro de la mano que sigue.
    //
    // La ficha y el lado NO se apuntan: los guarda `board.tiles` con su `playedBy` (§`PastMove`).
    this.moves.record("PLAY_TILE", playerId);
    this.players.playTile(playerId, tile, side);
    return this.matchDriver.advance(playerId, "PLAYED").events;
  }
}
