import { describe, expect, it } from "vitest";
import { fullPotFor } from "./full-pot";

describe("fullPotFor", () => {
  it("2P: el pozo completo es entryFee × 2 jugadores, para el único ganador", () => {
    expect(
      fullPotFor({ entryFee: 100, prizePerWinner: 180, playersQuantity: 2, nominalWinners: 1 }),
    ).toEqual({ amountPerWinner: 200, formulaBroken: false });
  });

  it("4P: el pozo se reparte entre los ganadores NOMINALES de la pareja", () => {
    // pozo = 100 × 4 = 400, repartido entre los 2 de la pareja → 200 cada uno.
    expect(
      fullPotFor({ entryFee: 100, prizePerWinner: 180, playersQuantity: 4, nominalWinners: 2 }),
    ).toEqual({ amountPerWinner: 200, formulaBroken: false });
  });

  it("fórmula rota (el pozo por ganador no supera el premio normal): paga el premio normal", () => {
    expect(
      fullPotFor({ entryFee: 10, prizePerWinner: 500, playersQuantity: 2, nominalWinners: 1 }),
    ).toEqual({ amountPerWinner: 500, formulaBroken: true });
  });

  it("sin ganadores nominales también es fórmula rota, no un pozo infinito", () => {
    expect(
      fullPotFor({ entryFee: 100, prizePerWinner: 180, playersQuantity: 2, nominalWinners: 0 }),
    ).toEqual({ amountPerWinner: 180, formulaBroken: true });
  });

  it("es agnóstica del aumento: quien llama ya escaló la inscripción y el premio", () => {
    // Mesa base 100/180 con un x3 aceptado, ya aplicado por quien llama.
    expect(
      fullPotFor({ entryFee: 300, prizePerWinner: 540, playersQuantity: 2, nominalWinners: 1 }),
    ).toEqual({ amountPerWinner: 600, formulaBroken: false });
  });
});
