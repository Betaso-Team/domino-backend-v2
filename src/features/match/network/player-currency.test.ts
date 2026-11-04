import { describe, expect, it } from "vitest";
import { addDecimals, localMoneyOf, zeroLike } from "./player-currency";

const price = {
  currency: "VES",
  rate: "200",
  entry: "200.00",
  prize: "300.00",
  levels: [{ level: 2, entry: "200.00", prize: "600.00" }],
};

describe("addDecimals: la suma exacta de dos montos de texto", () => {
  it.each([
    ["200.00", "200.00", "400.00"],
    ["200", "0.5", "200.5"],
    ["0.1", "0.2", "0.3"],
    ["0.05", "0.05", "0.10"],
    ["999.99", "0.01", "1000.00"],
    ["7", "8", "15"],
    // MÁS ALLÁ DE LA MANTISA: un `number` perdería el último centavo.
    ["90071992547409.93", "0.01", "90071992547409.94"],
  ])("%s + %s = %s", (left, right, sum) => {
    expect(addDecimals(left, right)).toBe(sum);
  });
});

describe("zeroLike: el cero con los decimales del monto", () => {
  it("copia la escala, o ninguna", () => {
    expect(zeroLike("300.00")).toBe("0.00");
    expect(zeroLike("300")).toBe("0");
  });
});

describe("localMoneyOf: la plata del asiento en su moneda, elegida del precio", () => {
  it("sin aumento: la entrada y el premio de x1; nivel 0 y nivel 1 son lo mismo", () => {
    for (const level of [0, 1]) {
      expect(localMoneyOf(price, level, { charged: true, paid: true })).toEqual({
        chargedInPlayerCurrency: "200.00",
        prizePaidInPlayerCurrency: "300.00",
      });
    }
  });

  it("con aumento: la entrada más lo que costó subir, y el premio del nivel", () => {
    expect(localMoneyOf(price, 2, { charged: true, paid: true })).toEqual({
      chargedInPlayerCurrency: "400.00",
      prizePaidInPlayerCurrency: "600.00",
    });
  });

  it("sin cobro ni premio, ceros con la escala del precio", () => {
    expect(localMoneyOf(price, 2, { charged: false, paid: false })).toEqual({
      chargedInPlayerCurrency: "0.00",
      prizePaidInPlayerCurrency: "0.00",
    });
  });

  it("un nivel que el precio no cotizó no se adivina", () => {
    expect(localMoneyOf(price, 3, { charged: true, paid: true })).toBeUndefined();
  });
});
