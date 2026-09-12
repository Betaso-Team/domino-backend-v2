import { describe, expect, it } from "vitest";
import { firstPlayerOf } from "../first-turn.js";

const hands = (entries: [string, [number, number][]][]) =>
  entries.map(([playerId, tiles]) => ({
    playerId,
    tiles: tiles.map(([left, right]) => ({ left, right })),
  }));

describe("firstPlayerOf — reglas §3.2", () => {
  it("arranca quien tiene el doble seis", () => {
    const who = firstPlayerOf(
      hands([
        [
          "u1",
          [
            [5, 4],
            [3, 2],
          ],
        ],
        [
          "u2",
          [
            [6, 6],
            [0, 1],
          ],
        ],
      ]),
    );
    expect(who).toBe("u2");
  });

  it("si nadie tiene el doble seis, arranca quien tiene la ficha de mayor valor", () => {
    const who = firstPlayerOf(
      hands([
        [
          "u1",
          [
            [5, 4],
            [1, 1],
          ],
        ],
        [
          "u2",
          [
            [6, 5],
            [0, 0],
          ],
        ],
      ]),
    );
    expect(who).toBe("u2");
  });

  it("empate de valor máximo: gana el asiento más bajo, y es determinista", () => {
    const entries = hands([
      ["u1", [[6, 5]]],
      ["u2", [[5, 6]]],
    ]);
    expect(firstPlayerOf(entries)).toBe("u1");
    expect(firstPlayerOf(entries)).toBe("u1");
  });

  it("el doble seis manda incluso contra una ficha de valor igual", () => {
    const who = firstPlayerOf(
      hands([
        ["u1", [[6, 6]]],
        ["u2", [[6, 6]]],
      ]),
    );
    expect(who).toBe("u1");
  });

  it("una lista sin manos rompe la invariante", () => {
    expect(() => firstPlayerOf([])).toThrow();
  });
});
