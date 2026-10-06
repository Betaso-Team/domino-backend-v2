import {
  type ParticipationReporter,
  type TournamentConfig,
  computeQuality,
} from "@/features/tournament";
import type { MatchState } from "../../core/state";
import type { TournamentRoomOptions } from "../../transports/match-contract";
import type { MatchEventSink, MatchMessenger } from "../listeners";

/**
 * LA PARTIDA DE TORNEO SE DECIDIÓ: una fila de participación por jugador, con la calidad de la
 * partida, y a cada uno SUS puntos — es el momento en que mira la pantalla de cierre, que es justo
 * cuando quiere saber cuánto sumó. Por jugador y no difundido: los dos suman distinto, y el número
 * de uno no es asunto del otro.
 *
 * Una partida sin veredicto no reporta nada: allá no cuenta para la tabla.
 */
export function reportParticipation(deps: {
  readonly options: TournamentRoomOptions;
  readonly matchId: string;
  readonly match: MatchState;
  readonly reporter: ParticipationReporter;
  readonly config: TournamentConfig;
  readonly send: MatchMessenger;
  readonly now: () => number;
}): MatchEventSink {
  const { options, matchId, match, reporter, config, send, now } = deps;
  return (events) => {
    for (const event of events) {
      if (event.type !== "MATCH_RESOLVED") continue;
      const roundsPlayed = match.pastRounds.length;
      const durationMs = Math.max(0, now() - match.startedAt);
      const quality = computeQuality(roundsPlayed, durationMs, config);
      for (const player of match.players) {
        const won = player.teamId === event.winnerTeamId;
        const score = won ? quality.grade : options.pointsPerLoss;
        const reported = reporter.report({
          tournamentId: options.tournamentId,
          matchId,
          playerId: player.playerId,
          username: player.username ?? "",
          profilePicture: player.profilePicture ?? "",
          score,
          matchScore:
            player.teamId === "A" ? (match.scoreboard?.teamA ?? 0) : (match.scoreboard?.teamB ?? 0),
          wins: won ? 1 : 0,
          losses: won ? 0 : 1,
          gamesPlayed: 1,
          roundsPlayed,
          durationMs,
          qualityRatio: quality.ratio,
          grade: quality.grade,
        });
        if (reported)
          send(player.playerId, "MATCH_POINTS", {
            score,
            reduced: won && score < (config.qualityScale[0]?.points ?? 0),
          });
      }
    }
  };
}
