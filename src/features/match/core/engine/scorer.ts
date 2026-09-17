import type { PlayerId } from "../ids";
import { RoundSummary } from "../state/index";
import type { MatchState } from "../state/index";
import type { RoundEndReason } from "../state/round";
import { scoreboardOf, teamOf } from "./state-projections";

export interface RoundVerdict {
  readonly roundNumber: number;
  readonly winnerId: PlayerId | undefined;
  readonly points: number;
  readonly reason: RoundEndReason;
}

// Único escritor del marcador y del archivo de rondas.
export class Scorer {
  constructor(private readonly match: MatchState) {}

  credit(verdict: RoundVerdict): void {
    const summary = new RoundSummary();
    summary.roundNumber = verdict.roundNumber;
    summary.points = verdict.points;
    summary.reason = verdict.reason;

    if (verdict.winnerId) {
      const winnerTeamId = teamOf(verdict.winnerId, this.match);
      const scoreboard = scoreboardOf(this.match);
      if (winnerTeamId === "A") scoreboard.teamA += verdict.points;
      else scoreboard.teamB += verdict.points;
      summary.winnerId = verdict.winnerId;
      summary.winnerTeamId = winnerTeamId;
    } else {
      summary.winnerId = "";
      summary.winnerTeamId = "";
    }

    this.match.pastRounds.push(summary);
  }
}
