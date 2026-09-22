import type { TournamentConfig } from "./config";

/**
 * THE ANTIFRAUDE FORMULA. Its purpose in one line: a win is worth less when the
 * match was abnormally short, so walking out stops being a cheap way to score.
 *
 * It measures against TWO axes and takes the WORSE, and that is not excess caution:
 * each covers the other's hole. By rounds alone, someone could stretch a match by
 * playing extremely slowly without playing anything; by time alone, they could
 * leave it open without touching a card. Demanding both leaves one path to a full
 * score, which is actually playing.
 *
 * It is a PURE function over numbers: it knows neither the match state nor the
 * player. Who hands it the rounds and the duration is the scope's translator.
 */

export interface MatchQuality {
  /** Rounds played ÷ rounds expected. */
  readonly roundsRatio: number;
  /** Real minutes ÷ expected minutes. */
  readonly durationRatio: number;
  /** The worse of the two: the one that rules. */
  readonly ratio: number;
  /** The score the winner earns according to the scale. */
  readonly grade: number;
}

export function computeQuality(
  roundsPlayed: number,
  durationMs: number,
  config: TournamentConfig,
): MatchQuality {
  const roundsRatio = roundsPlayed / config.avgRounds;
  const durationRatio = durationMs / 60_000 / config.avgDurationMinutes;
  const ratio = Math.min(roundsRatio, durationRatio);
  return { roundsRatio, durationRatio, ratio, grade: gradeOf(ratio, config) };
}

/**
 * The first rung the ratio reaches, walking from most to least demanding. With
 * an empty scale — a broken config — it returns 0 rather than blowing up:
 * leaving someone without points is recoverable, bringing down the close of a
 * match is not.
 */
export function gradeOf(ratio: number, config: TournamentConfig): number {
  return config.qualityScale.find((step) => ratio >= step.minRatio)?.points ?? 0;
}
