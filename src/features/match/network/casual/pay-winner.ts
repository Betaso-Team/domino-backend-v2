import type { Outbox } from "@/features/economy";
import type { MatchState } from "../../core/state";
import type { MatchEventSink } from "../listeners";
import { prizeWinnersOf, stakesOf } from "../settlement";

/**
 * LA PARTIDA SE CERRÓ CON GANADOR, así que se paga el premio: el de la mesa POR EL NIVEL del aumento
 * aceptado (`stakesOf`), y sólo a quien sigue siendo una persona (`prizeWinnersOf`). Por el outbox y
 * no en línea: una vez elegido el monto no queda nada que decidir, y lo que hace falta es que la
 * entrega esté garantizada.
 *
 * El aumento se lee del ÁRBOL al cerrar y no del evento que lo acordó: si no se pudo cobrar ya se
 * anuló (`revokeMultiplier`), así que lo que dice el estado es la respuesta YA RESUELTA.
 */
export function payWinner(deps: {
  readonly matchId: string;
  readonly match: MatchState;
  readonly table: { readonly entryFee: number; readonly prize: number };
  readonly outbox: Outbox | undefined;
}): MatchEventSink {
  const { matchId, match, table, outbox } = deps;
  return (events) => {
    for (const event of events) {
      if (event.type !== "MATCH_RESOLVED") continue;
      const { prize } = stakesOf(table, match);
      for (const playerId of prizeWinnersOf(match, event.winnerTeamId)) {
        outbox?.enqueue({ matchId, playerId, amount: prize, reason: "PRIZE" }, "CREDIT");
      }
    }
  };
}
