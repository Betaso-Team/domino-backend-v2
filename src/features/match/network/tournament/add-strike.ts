import type { StrikeBook } from "@/features/tournament";
import type { Logger } from "@/shared/logger";
import { wasAbortedAtDeal } from "../../core/rules";
import type { MatchState } from "../../core/state";
import type { MatchEventSink, MatchMessenger } from "../listeners";

/**
 * IRSE DE UNA PARTIDA DE TORNEO CUESTA UN STRIKE, y quién dijo el abandono decide cuándo:
 *
 *   · el SISTEMA, retirando al que se quedó sin tiempo, se cobra en el acto — salvo que haya sido la
 *     ventana de reparto: no levantar a tiempo no cuesta nada (v1 no anota strike en
 *     `on-timeout-reveal.ts`).
 *   · el JUGADOR, con el verbo. Un comando no emite evento, así que se lee del estado al cerrarse:
 *     el que abandonó y no fue retirado por el sistema se fue a propósito. Es el `consented` de v1
 *     (`tournaments/game/commands/on-leave.ts:33`), que cuesta en cualquier momento — también con
 *     la ventana de reparto abierta.
 *
 * Sólo torneo: en casual, irse ya cuesta la inscripción.
 */
export function addStrike(deps: {
  readonly tournamentId: string;
  readonly match: MatchState;
  readonly strikes: StrikeBook;
  // A QUIEN LE COSTÓ, y a nadie más: difundirlo le daría al rival la cuenta de cuántas veces se va.
  readonly send: MatchMessenger;
  readonly log: Logger;
}): MatchEventSink {
  const { tournamentId, match, strikes, send, log } = deps;
  // A QUIÉN RETIRÓ EL SISTEMA, que es lo único que distingue un abandono del otro: el estado dice
  // `hasAbandoned` para los dos, y sólo el `ABANDON` del sistema existe como evento.
  const droppedBySystem = new Set<string>();
  // Un strike por persona y por partida, aunque el cierre llegue por dos caminos.
  const struck = new Set<string>();
  const strike = (playerId: string) => {
    if (struck.has(playerId)) return;
    struck.add(playerId);
    void strikes
      .add(tournamentId, playerId)
      .then((penalty) =>
        send(playerId, "TOURNAMENT_PENALTY", {
          strikes: penalty.strikes,
          penalizedUntil:
            penalty.blockedUntil > 0 ? new Date(penalty.blockedUntil).toISOString() : null,
        }),
      )
      .catch((err) => log.error("no se pudo anotar el strike", { err, playerId }));
  };
  return (events) => {
    for (const event of events) {
      if (event.type === "ABANDON") {
        droppedBySystem.add(event.playerId);
        if (!wasAbortedAtDeal(match)) strike(event.playerId);
      }
      if (event.type === "MATCH_RESOLVED" || event.type === "MATCH_ABORTED") {
        for (const player of match.players) {
          if (player.hasAbandoned && !droppedBySystem.has(player.playerId)) strike(player.playerId);
        }
      }
    }
  };
}
