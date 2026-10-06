import type { WalletPort } from "@/features/economy";
import type { Logger } from "@/shared/logger";
import type { MatchState } from "../../core/state";
import type { MatchEventSink } from "../listeners";
import { isRefundable } from "../settlement";

/**
 * LA PARTIDA TERMINÓ SIN VEREDICTO, así que lo cobrado vuelve. No a todos: el que se fue habiendo
 * levantado sus fichas pierde la inscripción (`isRefundable`).
 *
 * No nombra montos ni billeteras: manda la partida y los asientos, y el otro lado reconstruye lo
 * que cobró y lo revierte. Eso es lo que lo hace idempotente allá, y por eso no necesita outbox. Lo
 * que sí necesita es su `catch`, porque esto corre justo cuando algo ya salió mal.
 */
export function refundOnAbort(deps: {
  readonly matchId: string;
  readonly match: MatchState;
  readonly wallet: Pick<WalletPort, "refundMatch">;
  readonly log: Logger;
}): MatchEventSink {
  const { matchId, match, wallet, log } = deps;
  return (events) => {
    if (!events.some((event) => event.type === "MATCH_ABORTED")) return;
    void wallet
      .refundMatch(
        matchId,
        match.players.filter(isRefundable).map(({ playerId }) => playerId),
      )
      .catch((err) => log.error("falló el reembolso de sala", { err, matchId }));
  };
}
