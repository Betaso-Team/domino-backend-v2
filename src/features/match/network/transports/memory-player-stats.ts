import {
  EMPTY_STATS,
  type PlayerStats,
  type PlayerStatsStore,
  type StatsLine,
} from "../player-stats";

type Entry = PlayerStats & { readonly lastEndedAt: Date };

// LOS CONTADORES DE LA INSTANCIA SIN BASE. No es un doble: es el adaptador de quien no configura Mongo, y
// corre el mismo contrato. La regla de orden es la de Mongo: sólo cuenta una línea MÁS NUEVA que la última.
export class MemoryPlayerStats implements PlayerStatsStore {
  private readonly entries = new Map<string, Entry>();

  // `now` queda por simetría con el adaptador de Mongo y por si el día de mañana se graba `updatedAt`.
  constructor(readonly now: () => Date = () => new Date()) {}

  async apply(line: StatsLine): Promise<"applied" | "skipped"> {
    const current = this.entries.get(line.userId);
    if (current && current.lastEndedAt.getTime() >= line.endedAt.getTime()) return "skipped";

    const base = current ?? EMPTY_STATS;
    const won = line.result === "win";
    const currentStreak = won ? base.currentStreak + 1 : 0;
    this.entries.set(line.userId, {
      gamesPlayed: base.gamesPlayed + 1,
      gamesWon: base.gamesWon + (won ? 1 : 0),
      gamesWonFourPlayers: base.gamesWonFourPlayers + (won && line.fourPlayers ? 1 : 0),
      gamesAbandoned: base.gamesAbandoned + (line.result === "abandoned" ? 1 : 0),
      currentStreak,
      maxStreak: Math.max(base.maxStreak, currentStreak),
      lastEndedAt: line.endedAt,
    });
    return "applied";
  }

  async of(userId: string): Promise<PlayerStats> {
    const current = this.entries.get(userId);
    if (!current) return EMPTY_STATS;
    const { lastEndedAt: _ignored, ...stats } = current;
    return stats;
  }
}
