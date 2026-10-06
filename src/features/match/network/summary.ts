import type { MatchState } from "../core/state";
import type { DominoRoomOptions } from "../transports/match-contract";
import type { MatchEventSink } from "./listeners";
import type { MatchSummaryPort } from "./player-log";

/**
 * LA PARTIDA TERMINÓ, así que se escribe UNA FILA que diga qué fue: quién ganó, qué costó y con qué
 * cerró cada uno. Los dos finales, y se distinguen en vez de mezclarse: una partida con veredicto
 * cobró una inscripción y pagó un premio, una abortada reembolsó. Un historial que las llamara igual
 * le mostraría a un jugador una derrota que nunca jugó.
 *
 * UNA por partida aunque el cierre llegue por dos caminos: lo recuerda el cierre de esta función,
 * que vive lo que vive la mesa.
 */
export function recordSummary(deps: {
  readonly options: DominoRoomOptions;
  readonly matchId: string;
  readonly match: MatchState;
  readonly summaries: MatchSummaryPort;
  readonly now: () => number;
}): MatchEventSink {
  const { options, matchId, match, summaries, now } = deps;
  let summarized = false;
  return (events) => {
    for (const event of events) {
      if (event.type !== "MATCH_RESOLVED" && event.type !== "MATCH_ABORTED") continue;
      if (summarized) return;
      summarized = true;
      const scoreOf = (teamId: string) =>
        teamId === "A" ? (match.scoreboard?.teamA ?? 0) : (match.scoreboard?.teamB ?? 0);
      const playerOf = (player: MatchState["players"][number]) => ({
        id: player.playerId,
        score: scoreOf(player.teamId),
        currency: player.currency,
      });
      summaries.summarize({
        matchId,
        status: event.type === "MATCH_RESOLVED" ? "finished" : "canceled",
        winnerIds:
          event.type === "MATCH_RESOLVED"
            ? match.players
                .filter(({ teamId }) => teamId === event.winnerTeamId)
                .map(({ playerId }) => playerId)
            : [],
        entryFee: options.mode === "CASUAL" ? options.entryFee : 0,
        prize: options.mode === "CASUAL" ? options.prize : 0,
        isFreeRoom: options.mode === "CASUAL" ? options.isFreeRoom : false,
        gameModeId: options.mode === "CASUAL" ? options.gameModeId : options.tournamentId,
        players: match.players.filter(({ hasAbandoned }) => !hasAbandoned).map(playerOf),
        quitPlayers: match.players.filter(({ hasAbandoned }) => hasAbandoned).map(playerOf),
        playedAt: new Date(now()),
      });
    }
  };
}
