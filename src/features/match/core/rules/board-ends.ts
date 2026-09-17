import type { BoardView, PlacedTileView } from "./view";

// DE QUÉ PUNTA DE LA CADENA se cuelga una ficha. Vive con los extremos —y no junto al schema,
// que es de donde salió— porque es vocabulario de REGLA: `playableSides` lo devuelve y
// `canPlayTile` lo juzga. `state/tile.ts` lo re-exporta.
export type BoardSide = "LEFT" | "RIGHT";

// El angostamiento del eje, y va ACÁ y no con las otras proyecciones por una razón mecánica: el
// tipo que angosta se declara arriba, así que tenerlo en `projections.ts` cerraba un ciclo entre
// los dos archivos (`board-ends` → `projections` → `board-ends`). Que la palabra y su
// angostamiento vivan juntos es, además, lo correcto.
export const sideOf = (placed: PlacedTileView): BoardSide => placed.side as BoardSide;

// Los extremos NO son campos del estado: se DERIVAN de la cadena jugada.
// Almacenarlos invitaría a la desincronización (spec §7.1).
//
// Pide una `BoardView` y no el `BoardState`: el nodo de Colyseus la satisface tal cual, y así
// el cliente puede derivar los extremos con ESTA función en vez de reimplementar el recorrido
// —que es la única forma real de que los dos lados se desincronicen: tenerlo escrito dos veces—.
export interface BoardEnds {
  readonly left: number | undefined;
  readonly right: number | undefined;
}

export function boardEndsOf(board: BoardView): BoardEnds {
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
