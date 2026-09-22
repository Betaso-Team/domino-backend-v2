import { describe, expect, it } from "vitest";
import { DEFAULT_TOURNAMENT_CONFIG as CFG } from "../config";
import { computeQuality, gradeOf } from "../quality";

const MINUTE = 60_000;
// A "normal" match according to the expected stats: roughly six rounds and three minutes.
const FULL_ROUNDS = CFG.avgRounds;
const FULL_MS = CFG.avgDurationMinutes * MINUTE;

describe("La fórmula antifraude: una victoria corta vale menos", () => {
  describe("la escala completa", () => {
    it.each([
      [1.0, 3, "partida completa"],
      [0.8, 3, "justo en el corte de arriba"],
      [0.79, 2, "apenas por debajo"],
      [0.3, 2, "justo en el corte del medio"],
      [0.29, 1, "abandono temprano"],
      [0.1, 1, "justo en el corte de abajo"],
      [0.09, 0, "abandono inmediato: no cuenta como victoria"],
      [0, 0, "no se jugó nada"],
    ])("ratio %s → %s puntos (%s)", (ratio, points) => {
      expect(gradeOf(ratio, CFG)).toBe(points);
    });
  });

  it("manda el PEOR de los dos ejes, no el promedio", () => {
    // Many rounds in an instant: whoever plays extremely fast to simulate a long match does not
    // debería sacar puntaje completo.
    const quality = computeQuality(FULL_ROUNDS, 0.1 * FULL_MS, CFG);

    expect(quality.roundsRatio).toBeCloseTo(1);
    expect(quality.durationRatio).toBeCloseTo(0.1);
    expect(quality.ratio).toBeCloseTo(0.1);
    expect(quality.grade).toBe(1);
  });

  it("y al revés: mucho tiempo con la mesa quieta tampoco alcanza", () => {
    // Leaving the room open without playing is the other hole, and the rounds axis covers it.
    const quality = computeQuality(0, 10 * FULL_MS, CFG);

    expect(quality.durationRatio).toBeCloseTo(10);
    expect(quality.ratio).toBe(0);
    expect(quality.grade).toBe(0);
  });

  it("una partida normal saca el puntaje completo", () => {
    expect(computeQuality(FULL_ROUNDS, FULL_MS, CFG).grade).toBe(3);
  });

  it("pasarse de largo no da más que el techo: la escala no premia alargar", () => {
    expect(computeQuality(FULL_ROUNDS * 5, FULL_MS * 5, CFG).grade).toBe(3);
  });

  it("con la escala vacía devuelve 0 en vez de romper: dejar sin puntos es recuperable", () => {
    expect(gradeOf(1, { ...CFG, qualityScale: [] })).toBe(0);
  });
});
