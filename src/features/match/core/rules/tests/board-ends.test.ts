import { describe, expect, it } from "vitest";
import { BoardState, PlacedTile, Tile } from "../../state/index";
import { boardEndsOf } from "../board-ends";

function board(placements: [number, number, "LEFT" | "RIGHT"][]): BoardState {
  const state = new BoardState();
  for (const [left, right, side] of placements) {
    const tile = new Tile();
    tile.left = left;
    tile.right = right;
    const placed = new PlacedTile();
    placed.tile = tile;
    placed.playedBy = "u1";
    placed.side = side;
    state.tiles.push(placed);
  }
  return state;
}

describe("boardEndsOf", () => {
  it("un tablero vacío no tiene extremos", () => {
    expect(boardEndsOf(board([]))).toEqual({ left: undefined, right: undefined });
  });

  it("la primera ficha fija los dos extremos", () => {
    expect(boardEndsOf(board([[6, 4, "RIGHT"]]))).toEqual({ left: 6, right: 4 });
  });

  it("una doble inicial deja los dos extremos iguales", () => {
    expect(boardEndsOf(board([[6, 6, "RIGHT"]]))).toEqual({ left: 6, right: 6 });
  });

  it("colgar a la derecha cambia solo el extremo derecho", () => {
    expect(
      boardEndsOf(
        board([
          [6, 4, "RIGHT"],
          [4, 2, "RIGHT"],
        ]),
      ),
    ).toEqual({ left: 6, right: 2 });
  });

  it("colgar a la izquierda cambia solo el extremo izquierdo", () => {
    expect(
      boardEndsOf(
        board([
          [6, 4, "RIGHT"],
          [3, 6, "LEFT"],
        ]),
      ),
    ).toEqual({ left: 3, right: 4 });
  });

  it("no importa de qué lado venga escrita la ficha que se cuelga", () => {
    expect(
      boardEndsOf(
        board([
          [6, 4, "RIGHT"],
          [6, 3, "LEFT"],
        ]),
      ),
    ).toEqual({ left: 3, right: 4 });
  });

  it("una doble colgada no cambia el extremo", () => {
    expect(
      boardEndsOf(
        board([
          [6, 4, "RIGHT"],
          [4, 4, "RIGHT"],
        ]),
      ),
    ).toEqual({ left: 6, right: 4 });
  });

  it("una cadena larga por los dos lados", () => {
    const ends = boardEndsOf(
      board([
        [6, 6, "RIGHT"],
        [6, 3, "RIGHT"],
        [3, 1, "RIGHT"],
        [2, 6, "LEFT"],
        [0, 2, "LEFT"],
      ]),
    );
    expect(ends).toEqual({ left: 0, right: 1 });
  });
});
