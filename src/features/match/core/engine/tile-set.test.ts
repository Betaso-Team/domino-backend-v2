import { describe, expect, it } from "vitest";
import {
  DOMINO_MAX_PIP,
  DOMINO_SET_SIZE,
  handValue,
  isDouble,
  orderedTileSet,
  sameTile,
  tileValue,
} from "./tile-set.js";

describe("tile-set", () => {
  it("son 28 fichas", () => {
    expect(orderedTileSet()).toHaveLength(DOMINO_SET_SIZE);
    expect(DOMINO_SET_SIZE).toBe(28);
  });

  it("no hay dos fichas iguales, tratando [a,b] y [b,a] como la misma", () => {
    const keys = orderedTileSet().map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`);
    expect(new Set(keys).size).toBe(DOMINO_SET_SIZE);
  });

  it("están las siete dobles", () => {
    const doubles = orderedTileSet().filter(([a, b]) => a === b);
    expect(doubles.map(([a]) => a)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("ningún número sale del rango 0..6", () => {
    for (const [a, b] of orderedTileSet()) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(DOMINO_MAX_PIP);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(DOMINO_MAX_PIP);
    }
  });

  it("el set completo suma 168 puntos", () => {
    const total = orderedTileSet().reduce((sum, [a, b]) => sum + a + b, 0);
    expect(total).toBe(168);
  });

  it("tileValue suma los dos números", () => {
    expect(tileValue({ left: 6, right: 4 })).toBe(10);
    expect(tileValue({ left: 0, right: 0 })).toBe(0);
  });

  it("isDouble reconoce las dobles", () => {
    expect(isDouble({ left: 3, right: 3 })).toBe(true);
    expect(isDouble({ left: 3, right: 4 })).toBe(false);
  });

  it("sameTile ignora el orden de los números", () => {
    expect(sameTile({ left: 6, right: 4 }, { left: 4, right: 6 })).toBe(true);
    expect(sameTile({ left: 6, right: 4 }, { left: 6, right: 5 })).toBe(false);
  });

  it("handValue suma toda la mano, y una mano vacía vale 0", () => {
    expect(
      handValue([
        { left: 6, right: 4 },
        { left: 3, right: 3 },
      ]),
    ).toBe(16);
    expect(handValue([])).toBe(0);
  });
});
