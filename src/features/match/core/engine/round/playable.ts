import type { BoardSide, TileLike } from "../../state/tile.js";
import type { BoardEnds } from "./board-ends.js";

export function playableSides(tile: TileLike, ends: BoardEnds): BoardSide[] {
  // Tablero vacío: la primera ficha entra, y la cadena todavía no tiene lados,
  // así que se normaliza a uno solo. Sin esto, la primera jugada tendría dos
  // representaciones del mismo tablero.
  if (ends.left === undefined || ends.right === undefined) return ["RIGHT"];

  const sides: BoardSide[] = [];
  if (tile.left === ends.left || tile.right === ends.left) sides.push("LEFT");
  if (tile.left === ends.right || tile.right === ends.right) sides.push("RIGHT");
  return sides;
}

export function hasPlayableTile(tiles: readonly TileLike[], ends: BoardEnds): boolean {
  return tiles.some((tile) => playableSides(tile, ends).length > 0);
}

// No hay `lockedNumberFor`: el número de engarce no se guarda (ver el comentario de
// `PlacedTile`), así que nadie del lado del servidor lo necesita. El front lo deriva
// recorriendo `board.tiles` con `side`, exactamente como `boardEndsOf`.
