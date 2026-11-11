import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MoneyError,
  UC,
  UC_DECIMALS,
  assertDecimal,
  fixed,
  isDecimal,
  readAmount,
  sameAmount,
} from "./money";

// LOS VECTORES COMPARTIDOS: `money.vectors.json` es copia del de `packages/money` (tablea-gaming-orchestrator,
// commit c9222ea), sin los grupos de lo que la copia de `money.ts` deja afuera (`money`, `ucOnly`, `toUc`,
// `isReservedCode`). Este archivo corre los mismos casos que `packages/money/src/tests/money.test.ts` para
// lo que sí se copió: que pasen acá es lo que prueba que la copia se comporta igual que el original.

// Los vectores traen entradas del tipo equivocado a propósito: las funciones las tienen que rechazar
// también en tiempo de ejecución.
// biome-ignore lint/suspicious/noExplicitAny: los vectores son datos sueltos de un JSON.
type Loose = Record<string, any>;

const GROUPS = ["fixed", "fixedErrors", "isDecimal", "readAmount", "readAmountErrors"] as const;

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

describe("el decimal estricto", () => {
  it.each(vectors.isDecimal)("isDecimal($value) = $expected", (v: Loose) => {
    expect(isDecimal(v.value)).toBe(v.expected);
  });

  it.each(vectors.isDecimal)("assertDecimal($value) lanza justo cuando no es uno", (v: Loose) => {
    if (v.expected) expect(() => assertDecimal(v.value)).not.toThrow();
    else expect(() => assertDecimal(v.value)).toThrow(MoneyError);
  });

  it("nombra el valor en el mensaje", () => {
    expect(() => assertDecimal("1e5", "el premio")).toThrow(/el premio/);
  });
});

describe("UC", () => {
  it("es el código como viaja, con 4 decimales", () => {
    expect(UC).toBe("UC");
    expect(UC_DECIMALS).toBe(4);
    expect(fixed("10", UC_DECIMALS)).toBe("10.0000");
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
