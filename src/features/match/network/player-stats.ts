import type { StoredMatchRecord } from "./history";
import { resultFor } from "./player-log";

// LAS ESTADÍSTICAS DE UN JUGADOR: la regla que baja una partida cerrada a una línea por jugador, y los
// puertos que la guardan. La regla es pura; quien la aplica (y reintenta) son los adaptadores.

export type StatsResult = "win" | "lose" | "abandoned";

/** Lo que una partida terminada le deja a UN jugador. */
export interface StatsLine {
  readonly userId: string;
  readonly endedAt: Date;
  readonly result: StatsResult;
  readonly fourPlayers: boolean;
}

export interface PlayerStats {
  readonly gamesPlayed: number;
  readonly gamesWon: number;
  readonly gamesWonFourPlayers: number;
  readonly gamesAbandoned: number;
  readonly currentStreak: number;
  readonly maxStreak: number;
}

export const EMPTY_STATS: PlayerStats = {
  gamesPlayed: 0,
  gamesWon: 0,
  gamesWonFourPlayers: 0,
  gamesAbandoned: 0,
  currentStreak: 0,
  maxStreak: 0,
};

/** Escribir es idempotente por (userId, endedAt): "skipped" = ya aplicada o más vieja que la última. */
export interface PlayerStatsStore {
  apply(line: StatsLine): Promise<"applied" | "skipped">;
  of(userId: string): Promise<PlayerStats>;
}

/** Los cierres cuyas estadísticas no se confirmaron. Lo implementan MemoryHistory y MongoHistory. */
export interface StatsBacklog {
  pending(endedBefore: Date, limit: number): Promise<StoredMatchRecord[]>;
  settled(matchId: string): Promise<void>;
}

const dateOf = (value: unknown): Date | undefined => {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return undefined;
};

const seatsOf = (document: StoredMatchRecord): { userId?: unknown }[] => {
  const field = Array.isArray(document.players) ? "players" : "seats";
  return (Array.isArray(document[field]) ? document[field] : []) as { userId?: unknown }[];
};

/** Sólo las TERMINADAS: una abortada o en curso no cuenta para nadie. */
export function linesOf(document: StoredMatchRecord): StatsLine[] {
  const endedAt = dateOf(document.matchEndedAt);
  if (document.status !== "finished" || endedAt === undefined) return [];
  const config = (document.matchConfig ?? {}) as { playersQuantity?: number };
  const seats = seatsOf(document);
  const ids = [
    ...new Set(seats.flatMap((seat) => (typeof seat.userId === "string" ? [seat.userId] : []))),
  ];
  const fourPlayers = (config.playersQuantity ?? seats.length) === 4;
  return ids.flatMap((userId) => {
    const result = resultFor(userId, document);
    return result === "canceled" ? [] : [{ userId, endedAt, result, fourPlayers }];
  });
}
