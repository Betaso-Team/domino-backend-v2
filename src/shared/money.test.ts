import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MoneyError, fixed, money, readAmount, sameAmount, toUc, ucOnly } from "./money";

// LOS VECTORES COMPARTIDOS: `money.vectors.json` es copia del de `packages/money` (tablea-gaming-orchestrator,
// commit 8e9732e), y este archivo corre los mismos casos que `packages/money/src/tests/money.test.ts`.
// Que pasen acá es lo que prueba que la copia de `money.ts` se comporta igual que el original.

// Los vectores traen entradas del tipo equivocado a propósito: las funciones las tienen que rechazar
// también en tiempo de ejecución.
// biome-ignore lint/suspicious/noExplicitAny: los vectores son datos sueltos de un JSON.
type Loose = Record<string, any>;

const GROUPS = [
  "fixed",
  "fixedErrors",
  "money",
  "moneyErrors",
  "ucOnly",
  "toUc",
  "toUcErrors",
  "readAmount",
  "readAmountErrors",
] as const;

const vectors: Record<(typeof GROUPS)[number], Loose[]> = JSON.parse(
  readFileSync(new URL("./money.vectors.json", import.meta.url), "utf8"),
);

it("el archivo de vectores tiene todos los grupos, y nada más", () => {
  expect(Object.keys(vectors).sort()).toEqual([...GROUPS].sort());
});

describe("fixed", () => {
  it.each(vectors.fixed)("fixed($text, $decimals) = $expected", (v: Loose) => {
    expect(fixed(v.text, v.decimals)).toBe(v.expected);
  });

  it.each(vectors.fixedErrors)("rechaza fixed($text, $decimals)", (v: Loose) => {
    expect(() => fixed(v.text, v.decimals)).toThrow(MoneyError);
  });
});

describe("money", () => {
  it.each(vectors.money)("money($currency, $amount, $decimals, $uc)", (v: Loose) => {
    const result = money(v.currency, v.amount, v.decimals, v.uc);
    // El orden de las llaves es parte de la forma: primero la moneda, después `uc`.
    expect(JSON.stringify(result)).toBe(JSON.stringify(v.expected));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(vectors.moneyErrors)("rechaza money($currency, $amount, $decimals, $uc)", (v: Loose) => {
    expect(() => money(v.currency, v.amount, v.decimals, v.uc)).toThrow(MoneyError);
  });

  it.each(vectors.ucOnly)("ucOnly($amount)", (v: Loose) => {
    expect(ucOnly(v.amount)).toEqual(v.expected);
  });
});

describe("toUc", () => {
  it.each(vectors.toUc)("toUc($amount, $rate) = $expected", (v: Loose) => {
    expect(toUc(v.amount, v.rate)).toBe(v.expected);
  });

  it.each(vectors.toUcErrors)("rechaza toUc($amount, $rate)", (v: Loose) => {
    expect(() => toUc(v.amount, v.rate)).toThrow(MoneyError);
  });
});

describe("readAmount", () => {
  it.each(vectors.readAmount)("readAmount($value, $currency) = $expected", (v: Loose) => {
    expect(readAmount(v.value, v.currency)).toBe(v.expected);
  });

  it.each(vectors.readAmountErrors)("rechaza readAmount($value, $currency)", (v: Loose) => {
    expect(() => readAmount(v.value, v.currency)).toThrow(MoneyError);
  });

  it("rechaza lo que JSON no puede llevar: NaN y los infinitos", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => readAmount(value, "VES")).toThrow(MoneyError);
    }
  });
});

describe("sameAmount", () => {
  it("compara el valor, no el texto", () => {
    expect(sameAmount("10", "10.0000")).toBe(true);
    expect(sameAmount("-0", "0.00")).toBe(true);
    expect(sameAmount("10", "10.0001")).toBe(false);
  });
});
