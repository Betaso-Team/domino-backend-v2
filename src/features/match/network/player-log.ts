export type MatchResult = "win" | "lose" | "abandoned" | "canceled";

export interface MatchSummaryPlayer {
  readonly id: string;
  readonly score: number;
  readonly currency: string;
}

export interface MatchSummary {
  readonly matchId: string;
  readonly status: "finished" | "canceled";
  readonly winnerIds: readonly string[];
  readonly entryFee: number;
  readonly prize: number;
  readonly isFreeRoom: boolean;
  readonly gameModeId: string;
  readonly players: readonly MatchSummaryPlayer[];
  readonly quitPlayers: readonly MatchSummaryPlayer[];
  readonly playedAt: Date;
}

export interface MatchSummaryPort {
  summarize(summary: MatchSummary): void;
}

export interface MatchRow {
  readonly id: string;
  readonly playedAt: string;
  readonly bet: number;
  readonly prize: number;
  readonly currency: string;
  readonly score: number;
  readonly result: MatchResult;
  readonly freeRoom: boolean;
}

export interface PlayerStats {
  readonly gamesPlayed: number;
  readonly gamesWon: number;
  readonly winRate: number;
  readonly maxWinStreak: number;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
  readonly totalItems: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface PlayerLog {
  pageOf(playerId: string, page: number, perPage: number): Promise<Paginated<MatchRow>>;
  statsOf(playerId: string): Promise<PlayerStats>;
}

export function resultFor(playerId: string, match: MatchSummary): MatchResult {
  if (match.status === "canceled") return "canceled";
  if (match.winnerIds.includes(playerId)) return "win";
  if (match.quitPlayers.some(({ id }) => id === playerId)) return "abandoned";
  return "lose";
}

export function rowFor(playerId: string, match: MatchSummary): MatchRow {
  const player =
    match.players.find(({ id }) => id === playerId) ??
    match.quitPlayers.find(({ id }) => id === playerId);
  const result = resultFor(playerId, match);
  return {
    id: match.matchId,
    playedAt: match.playedAt.toISOString(),
    bet: result === "canceled" ? 0 : match.entryFee,
    prize: result === "win" ? match.prize : 0,
    currency: player?.currency ?? "",
    score: player?.score ?? 0,
    result,
    freeRoom: match.isFreeRoom,
  };
}

export function statsFor(playerId: string, matches: readonly MatchSummary[]): PlayerStats {
  const played = matches.filter(
    (match) => match.status === "finished" && match.players.some(({ id }) => id === playerId),
  );
  const won = played.map((match) => match.winnerIds.includes(playerId));
  let current = 0;
  let maxWinStreak = 0;
  for (const value of won) {
    current = value ? current + 1 : 0;
    maxWinStreak = Math.max(maxWinStreak, current);
  }
  const gamesWon = won.filter(Boolean).length;
  return {
    gamesPlayed: played.length,
    gamesWon,
    winRate: played.length === 0 ? 0 : gamesWon / played.length,
    maxWinStreak,
  };
}
