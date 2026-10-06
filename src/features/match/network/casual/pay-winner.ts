import {
  type CoreLoopSettle,
  type CoreLoopSettleResult,
  type SoftWindowBook,
  fullPotFor,
} from "@/features/core-loop";
import type { Outbox } from "@/features/economy";
import { withTimeout } from "@/shared/deadline";
import type { Logger } from "@/shared/logger";
import type { MatchState } from "../../core/state";
import type { NetworkMatchEvent } from "../events";
import type { MatchEventSink } from "../listeners";
import { prizeWinnersOf, stakesOf } from "../settlement";

/** Lo que hace falta para preguntarle a core-loop. Ausente: esta instancia no tiene backend. */
export interface CoreLoopPayout {
  readonly client: CoreLoopSettle;
  readonly softWindow: SoftWindowBook;
  readonly timeoutMs: number;
}

/**
 * LA PARTIDA SE CERRÓ CON GANADOR, así que se paga el premio: el de la mesa POR EL NIVEL del aumento
 * aceptado (`stakesOf`), y sólo a quien sigue siendo una persona (`prizeWinnersOf`). Por el outbox y
 * no en línea: una vez elegido el monto no queda nada que decidir, y lo que hace falta es que la
 * entrega esté garantizada.
 *
 * El aumento se lee del ÁRBOL al cerrar y no del evento que lo acordó: si no se pudo cobrar ya se
 * anuló (`revokeMultiplier`), así que lo que dice el estado es la respuesta YA RESUELTA.
 *
 * **CON CORE-LOOP, EL PAGO ESPERA SU RESPUESTA**, acotada por `timeoutMs`: un pago por ganador es
 * mejor que dos (el premio normal y después la diferencia), aunque cueste una demora corta. Ante
 * cualquier fallo o plazo vencido falla CERRADO —el premio normal, nada más—: el beneficio es
 * accesorio, el pago no (v1, `core-loop.service.ts`).
 */
export function payWinner(deps: {
  readonly matchId: string;
  readonly match: MatchState;
  readonly table: {
    readonly entryFee: number;
    readonly prize: number;
    readonly isFreeRoom: boolean;
  };
  readonly outbox: Outbox | undefined;
  readonly coreLoop: CoreLoopPayout | undefined;
  // La respuesta de core-loop llega DESPUÉS de que el comando que cerró la partida volvió, así que
  // lo que produce —el veto de la ventana blanda— se cuenta por acá y no devolviéndolo.
  readonly emit: (events: readonly NetworkMatchEvent[]) => void;
  readonly log: Logger;
}): MatchEventSink {
  const { matchId, match, table, outbox, coreLoop, emit, log } = deps;

  const pay = (winnerTeamId: string, results: readonly CoreLoopSettleResult[]) => {
    const { entryFee, prize } = stakesOf(table, match);
    for (const playerId of prizeWinnersOf(match, winnerTeamId)) {
      const amount = waivedPrize(playerId, entryFee, prize, results);
      outbox?.enqueue({ matchId, playerId, amount, reason: "PRIZE" }, "CREDIT");
    }
  };

  // EL POZO COMPLETO para el que tiene el rake perdonado. Sólo en mesa paga: en una gratis no hay
  // comisión que perdonar. El divisor es NOMINAL —la mitad de la mesa—, la regla de v1 para que un
  // abandono no le pague el pozo entero al que quedó (`fullPotFor`).
  const waivedPrize = (
    playerId: string,
    entryFee: number,
    prize: number,
    results: readonly CoreLoopSettleResult[],
  ): number => {
    if (table.isFreeRoom) return prize;
    if (!results.find((result) => result.userId === playerId)?.rakeWaived) return prize;
    const pot = fullPotFor({
      entryFee,
      prizePerWinner: prize,
      playersQuantity: match.players.length,
      nominalWinners: Math.max(1, match.players.length / 2),
    });
    if (pot.formulaBroken)
      log.error("core-loop: pozo completo inválido, se paga el premio normal", {
        matchId,
        playerId,
        entryFee,
        prize,
      });
    return pot.amountPerWinner;
  };

  /**
   * LIQUIDA EN CORE-LOOP Y CONSUME EL BENEFICIO, una llamada por MONEDA CONGELADA: cada asiento pudo
   * pagar en la suya y el contrato acepta una sola por llamada, pero la idempotencia de core-loop es
   * por (userId, matchId), así que grupos disjuntos no se pisan. Sin máquinas —no tienen cuenta— y
   * con los que se fueron, que también consumen su cupo (v1, `getAllPlayersArrayWithQuitPlayers`).
   * Un grupo que no contesta a tiempo falla cerrado para ese grupo solo.
   */
  const settle = async (
    client: CoreLoopPayout,
    winnerTeamId: string,
  ): Promise<readonly CoreLoopSettleResult[]> => {
    const humans = match.players.filter(({ isBot }) => !isBot);
    const byCurrency = new Map<string, typeof humans>();
    for (const player of humans)
      byCurrency.set(player.currency, [...(byCurrency.get(player.currency) ?? []), player]);

    const results: CoreLoopSettleResult[] = [];
    for (const [currency, players] of byCurrency) {
      try {
        const response = await withTimeout(
          client.client.settle({
            matchId,
            currency,
            paid: !table.isFreeRoom,
            participants: players.map((player) => ({
              userId: player.playerId,
              won: player.teamId === winnerTeamId,
            })),
          }),
          client.timeoutMs,
        );
        results.push(...response.results);
      } catch (err: unknown) {
        log.error("core-loop no contestó a tiempo: se cobra rake normal para este grupo", {
          err,
          matchId,
          currency,
        });
      }
    }

    // LA VENTANA BLANDA AVANZA PARA TODOS los liquidados, ganen o pierdan: es la respuesta de
    // core-loop y no algo que se derive de `rakeWaived`. Perder esta nota sólo cuesta una cache local
    // vieja; la cuenta de core-loop sigue siendo la autoridad.
    for (const result of results)
      void client.softWindow
        .record(result.userId, result.softWindowRemaining)
        .catch((err: unknown) =>
          log.error("no se pudo guardar la ventana blanda", { err, playerId: result.userId }),
        );

    // Y SI ALGUNO SIGUE EN SU VENTANA, la pareja se veta un rato (v1,
    // `PairVetoService.registerVetoIfSoftWindow`): el beneficio no puede ser la forma de que dos
    // cuentas se crucen una y otra vez mientras una de ellas no paga comisión.
    if (results.some((result) => result.softWindowRemaining > 0))
      emit([{ type: "CASUAL_PAIR_VETOED", playerIds: humans.map(({ playerId }) => playerId) }]);

    return results;
  };

  return (events) => {
    for (const event of events) {
      if (event.type !== "MATCH_RESOLVED") continue;
      if (!coreLoop) {
        pay(event.winnerTeamId, []);
        continue;
      }
      const { winnerTeamId } = event;
      void settle(coreLoop, winnerTeamId)
        .then((results) => pay(winnerTeamId, results))
        .catch((err: unknown) => log.error("no se pudo pagar al ganador", { err, matchId }));
    }
  };
}
