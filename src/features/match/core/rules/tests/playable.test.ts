import { describe, expect, it } from "vitest";
import { hasPlayableTile, playableSides } from "../playable";

const empty = { left: undefined, right: undefined };
const ends = { left: 6, right: 2 };

describe("playableSides", () => {
  it("con el tablero vacío cualquier ficha entra, y de un solo lado", () => {
    expect(playableSides({ left: 5, right: 1 }, empty)).toEqual(["RIGHT"]);
  });

  it("engancha por izquierda si alguno de sus números es el extremo izquierdo", () => {
    expect(playableSides({ left: 6, right: 5 }, ends)).toEqual(["LEFT"]);
    expect(playableSides({ left: 5, right: 6 }, ends)).toEqual(["LEFT"]);
  });

  it("engancha por derecha si alguno de sus números es el extremo derecho", () => {
    expect(playableSides({ left: 2, right: 5 }, ends)).toEqual(["RIGHT"]);
  });

  it("una ficha que sirve de los dos lados devuelve los dos", () => {
    expect(playableSides({ left: 6, right: 2 }, ends)).toEqual(["LEFT", "RIGHT"]);
  });

  it("una ficha que no engancha no devuelve ningún lado", () => {
    expect(playableSides({ left: 5, right: 4 }, ends)).toEqual([]);
  });

  it("con los dos extremos iguales, una ficha que engancha sirve de los dos lados", () => {
    expect(playableSides({ left: 6, right: 5 }, { left: 6, right: 6 })).toEqual(["LEFT", "RIGHT"]);
  });
});

describe("hasPlayableTile", () => {
  it("es verdadero si al menos una ficha engancha", () => {
    expect(
      hasPlayableTile(
        [
          { left: 5, right: 4 },
          { left: 6, right: 1 },
        ],
        ends,
      ),
    ).toBe(true);
  });

  it("es falso si ninguna engancha", () => {
    expect(
      hasPlayableTile(
        [
          { left: 5, right: 4 },
          { left: 3, right: 1 },
        ],
        ends,
      ),
    ).toBe(false);
  });

  it("con el tablero vacío, cualquier mano no vacía tiene jugada", () => {
    expect(hasPlayableTile([{ left: 5, right: 4 }], empty)).toBe(true);
  });

  it("una mano vacía nunca tiene jugada", () => {
    expect(hasPlayableTile([], ends)).toBe(false);
  });
});
