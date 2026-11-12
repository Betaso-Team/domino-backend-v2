import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Decimal, decimal, fromNumber } from "../decimal";
import { fixed } from "../money";
import { betDifference, stakeAt, toCurrency } from "../pricing";

// LOS VECTORES COMPARTIDOS: `pricing.vectors.json` es copia del de `packages/money` (tablea-gaming-orchestrator,
// commit 85cd1a4) y este archivo es su `src/tests/pricing.test.ts` adaptado: los dos repos calculan el
// mismo decimal para la misma mesa, y que pasen acá es lo que lo prueba.
// biome-ignore lint/suspicious/noExplicitAny: los vectores son datos sueltos de un JSON.
type Loose = Record<string, any>;
const vectors: Record<string, Loose[]> = JSON.parse(
  readFileSync(new URL("../pricing.vectors.json", import.meta.url), "utf8"),
);

describe("los vectores de las fórmulas", () => {
  it("el archivo trae los cuatro grupos, y nada más", () => {
    expect(Object.keys(vectors).sort()).toEqual(
      ["betDifference", "errors", "stakeAt", "toCurrency"].sort(),
    );
  });

  it.each(vectors.stakeAt ?? [])("stakeAt($base, $level) = $expected", (v) => {
    expect(stakeAt(decimal(v.base), v.level).eq(decimal(v.expected))).toBe(true);
  });

  it.each(vectors.betDifference ?? [])("betDifference($base, $level) = $expected", (v) => {
    expect(betDifference(decimal(v.base), v.level).eq(decimal(v.expected))).toBe(true);
  });

  it.each(vectors.toCurrency ?? [])("toCurrency($amountUc, $rate, $decimals) = $expected", (v) => {
    expect(toCurrency(decimal(v.amountUc), decimal(v.rate), v.decimals).toFixed(v.decimals)).toBe(
      v.expected,
    );
  });

  it.each(vectors.errors ?? [])("$fn rechaza sus argumentos", (v) => {
    const call = () =>
      v.fn === "stakeAt"
        ? stakeAt(decimal(v.base), v.level)
        : v.fn === "betDifference"
          ? betDifference(decimal(v.base), v.level)
          : toCurrency(decimal(v.amountUc), decimal(v.rate), v.decimals);
    expect(call).toThrow();
  });
});

describe("el defecto que el decimal cierra", () => {
  it("el premio a x6 es exactamente seis veces el premio, nunca un flotante", () => {
    // En `number`: 0.02 + 0.02 × 5 = 0.12000000000000001, y 0.02 × 6 = 0.12.
    expect(fixed(stakeAt(decimal("0.02"), 6).toString(), 4)).toBe("0.1200");
    const base = decimal("0.02");
    expect(base.plus(betDifference(base, 6)).eq(stakeAt(base, 6))).toBe(true);
  });

  it("entrada + diferencia del aumento = la mesa al nivel, en todo nivel y muchos premios", () => {
    for (let cents = 1; cents <= 100_000; cents += 997) {
      const base = new Decimal(String(cents)).div(new Decimal("100"));
      for (let level = 2; level <= 100; level += 1) {
        expect(base.plus(betDifference(base, level)).eq(stakeAt(base, level))).toBe(true);
      }
    }
  });

  it("un número se rechaza donde se espera un monto", () => {
    expect(() => new Decimal(0.1 as unknown as string)).toThrow();
    expect(fromNumber(0.1).toString()).toBe("0.1");
  });
});
