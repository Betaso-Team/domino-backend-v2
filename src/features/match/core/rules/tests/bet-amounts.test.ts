import { describe, expect, it } from "vitest";
import { betAmountsOf } from "../config";

// LO QUE CUESTA ACEPTAR UN AUMENTO, y es la regla que reemplazó a dos campos que nadie llenaba.
//
// ⚠ EL DEFECTO QUE ESTE ARCHIVO CIERRA: `BetLevel` guardaba `additionalEntryFee` y
// `additionalPrize` como si el catálogo los trajera. El catálogo del backend principal devuelve
// `{ level, extra, additionalPoints }` y NADA MÁS —no sabe cuánto cuesta esta mesa—, así que un
// cobro cableado contra esos campos habría cobrado CERO, en silencio y sin un solo rojo.
//
// La cuenta es la de v1 (`on-propose-bet-multiplier.ts:113-117`): la mesa ENTERA se multiplica
// por el nivel, y lo que se cobra es la diferencia contra lo ya pagado.

describe("betAmountsOf", () => {
  // EL NIVEL ES EL MULTIPLICADOR y no un índice: x2 cuesta una entrada más, no "la primera
  // opción de la lista". Es lo que hace que el catálogo remoto pueda no traer montos.
  it("cobra la diferencia contra la mesa, no el precio entero", () => {
    expect(betAmountsOf(2, 125, 250)).toEqual({
      additionalEntryFee: 125,
      additionalPrize: 250,
    });
  });

  it("escala con el nivel: el x5 cuesta cuatro entradas más", () => {
    expect(betAmountsOf(5, 125, 250)).toEqual({
      additionalEntryFee: 500,
      additionalPrize: 1_000,
    });
  });

  // LA MESA GRATIS NO COBRA NADA, y eso sale solo de la cuenta. No es la guarda que lo impide
  // —ésa es `isFreeRoom` en `canProposeBet`, que es un hecho distinto— pero es lo que hace que
  // si alguna vez se colara una oferta en una mesa gratis, el monto sea cero y no un invento.
  it("una mesa sin inscripción no cobra nada por aumentar", () => {
    expect(betAmountsOf(5, 0, 0)).toEqual({ additionalEntryFee: 0, additionalPrize: 0 });
  });

  // LAS UC ADMITEN DECIMALES desde que los montos son UC completas: una mesa de `1.5` existe en
  // el catálogo productivo de v1, y multiplicar no puede redondearla.
  it("conserva los decimales de las UC", () => {
    expect(betAmountsOf(3, 1.5, 2.75)).toEqual({ additionalEntryFee: 3, additionalPrize: 5.5 });
  });
});
