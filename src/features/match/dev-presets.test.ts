import { describe, expect, it } from "vitest";
import { dealPresetPatch, startingScoreBelow, startingScorePatch } from "./dev-presets";

// LAS DOS SECCIONES DE PRUEBA A MANO. Lo que tienen que rechazar es lo que dejaría un reparto o un
// marcador imposibles: una ficha repetida, un pip que no existe, una mano más larga que la mesa.
describe("el reparto preparado", () => {
  it("acepta manos parciales por asiento", () => {
    expect(dealPresetPatch.safeParse({ hands: [[[6, 6]], []] }).success).toBe(true);
  });

  it.each([
    ["una ficha repetida entre manos", { hands: [[[6, 5]], [[5, 6]]] }],
    ["un pip que no existe", { hands: [[[7, 0]]] }],
    ["una mano de más de siete", { hands: [Array.from({ length: 8 }, (_, i) => [i % 7, 0])] }],
    ["más de cuatro asientos", { hands: [[], [], [], [], []] }],
    ["un campo que no es editable", { vira: 1 }],
  ])("rechaza %s", (_, patch) => {
    expect(dealPresetPatch.safeParse(patch).success).toBe(false);
  });
});

describe("el marcador inicial", () => {
  it("rechaza puntos negativos o fraccionarios", () => {
    expect(startingScorePatch.safeParse({ teamA: -1 }).success).toBe(false);
    expect(startingScorePatch.safeParse({ teamB: 1.5 }).success).toBe(false);
  });

  // LA MISMA SECCIÓN SIRVE A TODAS LAS MESAS, así que no puede rechazar sola: la meta es de cada
  // mesa. Se acota al nacer, un punto por debajo, para que nadie nazca ganador.
  it("se acota un punto por debajo de la meta de la mesa", () => {
    expect(startingScoreBelow({ teamA: 500, teamB: 10 }, 100)).toEqual({ teamA: 99, teamB: 10 });
  });
});
