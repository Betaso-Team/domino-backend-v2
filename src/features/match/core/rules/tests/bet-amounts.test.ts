import { betDifference, decimal, stakeAt } from "@/shared/money";
import { describe, expect, it } from "vitest";

// LO QUE CUESTA ACEPTAR UN AUMENTO, y es la regla que reemplazó a dos campos que nadie llenaba.
//
// ⚠ EL DEFECTO QUE ESTE ARCHIVO CIERRA: `BetLevel` guardaba `additionalEntryFee` y
// `additionalPrize` como si el catálogo los trajera. El catálogo del backend principal devuelve
// `{ level, extra, additionalPoints }` y NADA MÁS —no sabe cuánto cuesta esta mesa—, así que un
// cobro cableado contra esos campos habría cobrado CERO, en silencio y sin un solo rojo.
//
// La cuenta es la de v1 (`on-propose-bet-multiplier.ts:113-117`): la mesa ENTERA se multiplica
// por el nivel, y lo que se cobra es la diferencia contra lo ya pagado. Hoy es UNA fórmula para
// todos los servicios, en el `Decimal` de billing (`@/shared/money/pricing.ts`, que corre los vectores
// del orquestador); estos casos son los del dominó.
const text = (amount: { toString(): string }) => amount.toString();

describe("betDifference: lo que cobra aceptar un nivel", () => {
  // EL NIVEL ES EL MULTIPLICADOR y no un índice: x2 cuesta una entrada más, no "la primera
  // opción de la lista". Es lo que hace que el catálogo remoto pueda no traer montos.
  it("cobra la diferencia contra la mesa, no el precio entero", () => {
    expect(text(betDifference(decimal("125"), 2))).toBe("125");
    expect(text(betDifference(decimal("250"), 2))).toBe("250");
  });

  it("escala con el nivel: el x5 cuesta cuatro entradas más", () => {
    expect(text(betDifference(decimal("125"), 5))).toBe("500");
    expect(text(betDifference(decimal("250"), 5))).toBe("1000");
  });

  // LA MESA GRATIS NO COBRA NADA, y eso sale solo de la cuenta. No es la guarda que lo impide
  // —ésa es `isFreeRoom` en `canProposeBet`, que es un hecho distinto— pero es lo que hace que
  // si alguna vez se colara una oferta en una mesa gratis, el monto sea cero y no un invento.
  it("una mesa sin inscripción no cobra nada por aumentar", () => {
    expect(text(betDifference(decimal("0"), 5))).toBe("0");
  });

  // LAS UC ADMITEN DECIMALES desde que los montos son UC completas: una mesa de `1.5` existe en
  // el catálogo productivo de v1, y multiplicar no puede redondearla.
  it("conserva los decimales de las UC", () => {
    expect(text(betDifference(decimal("1.5"), 3))).toBe("3");
    expect(text(betDifference(decimal("2.75"), 3))).toBe("5.5");
  });

  // LA ENTRADA YA PAGADA MÁS EL AUMENTO ES LA MESA AL NIVEL, exacto: es lo que el orquestador compara.
  it("la mesa más la diferencia es la mesa al nivel, sin coma flotante", () => {
    const base = decimal("0.02");
    expect(text(base.plus(betDifference(base, 6)))).toBe("0.12");
    expect(base.plus(betDifference(base, 6)).eq(stakeAt(base, 6))).toBe(true);
  });
});
