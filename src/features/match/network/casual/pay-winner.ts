import type { Outbox } from "@/features/economy";
import type { MatchState } from "../../core/state";
import type { MatchEventSink } from "../listeners";

/**
 * LA PARTIDA SE CERRÓ CON GANADOR, así que se paga el premio. Por el outbox y no en línea: una vez
 * elegido el monto no queda nada que decidir, y lo que hace falta es que la entrega esté
 * garantizada.
 */
export function payWinner(deps: {
  readonly matchId: string;
  readonly match: MatchState;
  readonly prize: number;
  readonly outbox: Outbox | undefined;
}): MatchEventSink {
  const { matchId, match, prize, outbox } = deps;
  return (events) => {
    for (const event of events) {
      if (event.type !== "MATCH_RESOLVED") continue;
      for (const player of match.players) {
        if (player.teamId !== event.winnerTeamId) continue;
        outbox?.enqueue(
          { matchId, playerId: player.playerId, amount: prize, reason: "PRIZE" },
          "CREDIT",
        );
      }
    }
  };
}
