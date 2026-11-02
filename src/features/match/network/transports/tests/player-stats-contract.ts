import { describe, expect, it } from "vitest";
import { EMPTY_STATS, type PlayerStatsStore, type StatsLine } from "../../player-stats";

// LOS CONTADORES DE UN JUGADOR, escritos una vez y corridos contra los dos adaptadores por el criterio de
// `./history-contract.ts`. No se pueden recalcular: un contador mal aplicado es un dato perdido, así que
// la idempotencia y el orden son lo que se mide acá.

const T0 = new Date("2026-11-02T12:00:00.000Z").getTime();
const at = (second: number) => new Date(T0 + second * 1_000);

const line = (second: number, overrides: Partial<StatsLine> = {}): StatsLine => ({
  userId: "ana",
  endedAt: at(second),
  result: "win",
  fourPlayers: false,
  ...overrides,
});

export function playerStatsContract(
  make: () => Promise<PlayerStatsStore> | PlayerStatsStore,
): void {
  describe("PlayerStatsStore (contrato)", () => {
    it("un jugador sin documento tiene los contadores en cero", async () => {
      const stats = await make();
      expect(await stats.of("nadie")).toEqual(EMPTY_STATS);
    });

    it("cuenta jugadas, victorias y las rachas en orden", async () => {
      const stats = await make();
      await stats.apply(line(1));
      await stats.apply(line(2));
      await stats.apply(line(3, { result: "lose" }));
      await stats.apply(line(4));

      expect(await stats.of("ana")).toEqual({
        ...EMPTY_STATS,
        gamesPlayed: 4,
        gamesWon: 3,
        currentStreak: 1,
        maxStreak: 2,
      });
    });

    it("abandonar cuenta como jugada y abandono, y corta la racha", async () => {
      const stats = await make();
      await stats.apply(line(1));
      await stats.apply(line(2, { result: "abandoned" }));

      expect(await stats.of("ana")).toEqual({
        ...EMPTY_STATS,
        gamesPlayed: 2,
        gamesWon: 1,
        gamesAbandoned: 1,
        currentStreak: 0,
        maxStreak: 1,
      });
    });

    it("ganar de a cuatro suma al contador de cuatro; perder de a cuatro no", async () => {
      const stats = await make();
      await stats.apply(line(1, { fourPlayers: true }));
      await stats.apply(line(2, { fourPlayers: true, result: "lose" }));

      const result = await stats.of("ana");
      expect(result.gamesWonFourPlayers).toBe(1);
      expect(result.gamesWon).toBe(1);
      expect(result.gamesPlayed).toBe(2);
    });

    it("aplicar la misma línea dos veces no cuenta dos", async () => {
      const stats = await make();
      expect(await stats.apply(line(1))).toBe("applied");
      expect(await stats.apply(line(1))).toBe("skipped");

      expect((await stats.of("ana")).gamesPlayed).toBe(1);
    });

    it("una línea más vieja que la última aplicada se saltea", async () => {
      const stats = await make();
      await stats.apply(line(5));
      expect(await stats.apply(line(3))).toBe("skipped");

      expect((await stats.of("ana")).gamesPlayed).toBe(1);
    });

    it("dos apply de la misma línea en el mismo turno cuentan una sola", async () => {
      const stats = await make();
      const outcomes = await Promise.all([stats.apply(line(1)), stats.apply(line(1))]);

      expect([...outcomes].sort()).toEqual(["applied", "skipped"]);
      expect((await stats.of("ana")).gamesPlayed).toBe(1);
    });

    // DOS LÍNEAS DISTINTAS PARA UN JUGADOR SIN DOCUMENTO: la MÁS NUEVA nunca se pierde. Si la vieja gana el
    // insert, se cuentan las dos; si gana la nueva, la vieja ya es más vieja que la última y se saltea (es
    // la regla, no una pérdida). Sin el reintento del adaptador de Mongo, la nueva podía recibir un E11000
    // del insert y descartarse (cerca de la mitad de las veces: por eso se repite).
    it("dos líneas distintas en carrera sobre un jugador nuevo nunca pierden la más nueva", async () => {
      const stats = await make();
      for (let round = 0; round < 20; round += 1) {
        const userId = `carrera-${round}`;
        const [older, newer] = await Promise.all([
          stats.apply(line(1, { userId })),
          stats.apply(line(2, { userId })),
        ]);

        expect(newer).toBe("applied");
        const result = await stats.of(userId);
        const applied = older === "applied" ? 2 : 1;
        expect(result.gamesPlayed).toBe(applied);
        expect(result.currentStreak).toBe(applied);
      }
    });

    it("la misma línea en carrera sobre un documento existente cuenta una sola", async () => {
      const stats = await make();
      await stats.apply(line(1));
      const outcomes = await Promise.all([stats.apply(line(2)), stats.apply(line(2))]);

      expect([...outcomes].sort()).toEqual(["applied", "skipped"]);
      expect((await stats.of("ana")).gamesPlayed).toBe(2);
    });

    it("los jugadores no se mezclan", async () => {
      const stats = await make();
      await stats.apply(line(1));
      await stats.apply(line(1, { userId: "luis", result: "lose" }));

      expect((await stats.of("ana")).gamesWon).toBe(1);
      expect(await stats.of("luis")).toEqual({ ...EMPTY_STATS, gamesPlayed: 1 });
    });
  });
}
