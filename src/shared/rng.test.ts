// src/shared/rng.test.ts
import { describe, expect, it } from "vitest";
import { hashSeed, mulberry32, shuffled } from "./rng.js";

describe("rng sembrado", () => {
  it("la misma semilla y ronda dan el mismo hash", () => {
    expect(hashSeed("abc", 1)).toBe(hashSeed("abc", 1));
  });

  it("distinta ronda da distinto hash", () => {
    expect(hashSeed("abc", 1)).not.toBe(hashSeed("abc", 2));
  });

  it("distinta semilla da distinto hash", () => {
    expect(hashSeed("abc", 1)).not.toBe(hashSeed("abd", 1));
  });

  it("mulberry32 es determinista y queda en [0,1)", () => {
    const first = Array.from({ length: 5 }, mulberry32(42));
    const second = Array.from({ length: 5 }, mulberry32(42));
    expect(first).toEqual(second);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("shuffled es una permutación y no muta la entrada", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = shuffled(input, mulberry32(7));
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...output].sort((a, b) => a - b)).toEqual(input);
  });

  it("shuffled con la misma semilla da el mismo orden", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffled(input, mulberry32(7))).toEqual(shuffled(input, mulberry32(7)));
  });

  it("shuffled con semillas distintas da órdenes distintos", () => {
    const input = Array.from({ length: 28 }, (_, index) => index);
    expect(shuffled(input, mulberry32(1))).not.toEqual(shuffled(input, mulberry32(2)));
  });
});
