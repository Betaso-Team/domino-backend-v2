import type { Ledger, Movement, WalletPort } from "@/features/economy";
import { withTimeout } from "@/shared/deadline";
import type { Logger } from "@/shared/logger";
import type { PlayerId } from "../core/ids";
import type { NetworkMatchEvent } from "./events";
import type { MatchEventSink } from "./listeners";

/**
 * EL COBRO DEL AUMENTO DE APUESTA. Se acordó el x5: los dos deben la diferencia.
 *
 * SE COBRA AL ACEPTAR Y NO AL LIQUIDAR, y no es un detalle de orden: cobrado al final, un
 * jugador podría aceptar un x5, verse perdiendo, y vaciar el saldo en otro juego antes del
 * cierre. La mesa habría prometido un premio que nadie respaldó.
 *
 * ES UN INTENTO Y NO UNA ORDEN, y el «si no se puede» tiene TRES partes que van juntas:
 *
 *   1. EN SERIE, cortando al primer fallo. En paralelo no se sabe quién pagó, y se le cobra a un
 *      tercero cuando ya se sabe que el aumento no se va a poder honrar.
 *   2. CON PLAZO, o «en vuelo» no tiene techo y una billetera muda deja el trato en el limbo —con
 *      la mesa diciendo x5 mientras tanto.
 *   3. AL FALLAR: REEMBOLSAR al que sí pagó y ANULAR el trato. Sin lo primero alguien queda sin
 *      su diferencia; sin lo segundo el estado diría x5 para siempre y el cierre pagaría un
 *      premio con dinero que no entró.
 *
 * EL MOTOR NO REVIERTE SOLO: se le pide por un verbo propio (`revokeMultiplier`). Es la
 * consecuencia de que el motor sea SÍNCRONO por contrato — asienta el trato sin poder esperar a
 * la billetera, así que la compensación es un segundo acto y no un rollback.
 */
export interface BetChargerDeps {
  readonly wallet: Pick<WalletPort, "charge" | "refund">;
  readonly ledger: Ledger;
  readonly timeoutMs: number;
  readonly log: Logger;
}

export class BetCharger {
  constructor(private readonly deps: BetChargerDeps) {}

  /**
   * EL SINK que la sala engancha. Reacciona a un solo evento.
   *
   * @param emit cómo se cuenta lo que pasa DESPUÉS. El cobro es asíncrono y el sink no lo es
   * —el motor es síncrono, así que lo único que un sink puede hacer es arrancar el trabajo—, con
   * lo cual la anulación llega cuando la llamada que la disparó ya volvió.
   * @param revoke deshace el trato en el motor de ESTA mesa y devuelve lo que haya que contar. Va
   * por sink y no por constructor porque el cobrador es del PROCESO y el motor es de la MESA:
   * tomarlo al construir sería compartir el motor de una partida con todas las demás. Es una
   * función opaca y no el grafo entero — lo único que este archivo puede hacerle al juego es
   * deshacer un aumento que no se pudo cobrar.
   */
  sinkFor(
    matchId: string,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    revoke: () => readonly NetworkMatchEvent[],
  ): MatchEventSink {
    return (events) => {
      for (const event of events) {
        if (event.type !== "MULTIPLIER_AGREED") continue;
        // Un aumento que no cuesta nada no se cobra. Pasa en una mesa gratis, que además no
        // debería ofrecer niveles — es la segunda cerradura, no la primera.
        if (event.additionalEntryFee <= 0) continue;
        void this.collect(matchId, event.playerIds, event.additionalEntryFee, emit, revoke).catch(
          (err: unknown) => this.deps.log.error("el cobro del aumento se cayó", { err, matchId }),
        );
      }
    };
  }

  private async collect(
    matchId: string,
    playerIds: readonly PlayerId[],
    amount: number,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    revoke: () => readonly NetworkMatchEvent[],
  ): Promise<void> {
    const paid: Movement[] = [];
    for (const playerId of playerIds) {
      const movement: Movement = { matchId, playerId, amount, reason: "BET_MULTIPLIER" };
      if (await this.charge(movement)) {
        paid.push(movement);
        continue;
      }
      await this.rollback(paid);
      // LA ANULACIÓN VA SIEMPRE, hayan salido o no los reembolsos: el trato no quedó respaldado,
      // y eso es cierto con independencia de cómo le fue a la devolución.
      emit(revoke());
      return;
    }
  }

  /** @returns si quedó pagado. Un movimiento ya asentado cuenta como pagado: nadie paga dos veces. */
  private async charge(movement: Movement): Promise<boolean> {
    try {
      await this.deps.ledger.reserve(movement);
    } catch {
      // Ya está en los libros. Para el desenlace cuenta como pagado, que es lo que hace que un
      // reintento no cobre de nuevo.
      return true;
    }
    try {
      await withTimeout(this.deps.wallet.charge(movement), this.deps.timeoutMs);
      await this.deps.ledger.settle(movement);
      return true;
    } catch (err: unknown) {
      // Sin saldo, la otra punta falló, o no contestó a tiempo. Los tres terminan igual.
      this.deps.log.warn("no se pudo cobrar el aumento", { err, playerId: movement.playerId });
      await this.deps.ledger.fail(movement);
      return false;
    }
  }

  private async rollback(paid: readonly Movement[]): Promise<void> {
    for (const movement of paid) {
      const refund: Movement = { ...movement, reason: "BET_MULTIPLIER_REFUND" };
      try {
        await this.deps.ledger.reserve(refund);
        await withTimeout(this.deps.wallet.refund(refund), this.deps.timeoutMs);
        await this.deps.ledger.settle(refund);
      } catch (err: unknown) {
        // QUEDA FALLIDO EN LOS LIBROS Y A LA VISTA, que es lo único honesto: deshacer un cobro
        // pide reconciliación, y reconciliar pide que el registro sobreviva. Tragarlo dejaría a
        // alguien sin su diferencia y sin rastro de que se le debe.
        this.deps.log.error("no se pudo devolver el aumento cobrado", {
          err,
          playerId: movement.playerId,
        });
        await this.deps.ledger.fail(refund);
      }
    }
  }
}
