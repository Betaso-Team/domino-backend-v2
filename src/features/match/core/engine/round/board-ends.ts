import type { BoardState } from "../../state/index.js";
import { sideOf } from "../state-projections.js";

// Los extremos NO son campos del estado: se DERIVAN de la cadena jugada.
// Almacenarlos invitaría a la desincronización (spec §7.1).
export interface BoardEnds {
  readonly left: number | undefined;
  readonly right: number | undefined;
}

export function boardEndsOf(board: BoardState): BoardEnds {
  const first = board.tiles.at(0);
  if (!first) return { left: undefined, right: undefined };

  let left = first.tile.left;
  let right = first.tile.right;

  for (let index = 1; index < board.tiles.length; index += 1) {
    const placed = board.tiles[index];
    if (!placed) continue;
    const { left: a, right: b } = placed.tile;
    // `sideOf` y no `placed.side`: el campo del schema es `string`, así que comparar
    // contra el literal a pelo deja pasar un typo que rompería la derivación entera.
    if (sideOf(placed) === "LEFT") {
      // El número que engancha es el que coincide con el extremo; queda el otro.
      // Con una doble, `a === b === left`, así que el extremo no cambia — correcto.
      left = a === left ? b : a;
    } else {
      right = a === right ? b : a;
    }
  }

  return { left, right };
}
