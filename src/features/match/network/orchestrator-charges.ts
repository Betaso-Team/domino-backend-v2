import { withTimeout } from "@/shared/deadline";
import type { Logger } from "@/shared/logger";
import { ZERO } from "@/shared/money";
import type { NetworkMatchEvent } from "./events";
import type { MatchEventSink } from "./listeners";

// LOS COBROS DE UNA MESA DEL ORQUESTADOR. Dominó no mueve dinero: cuando hace falta cobrar —la
// entrada con la mesa completa, un aumento acordado— le PIDE al orquestador que cobre y espera la
// respuesta. El orquestador cobra a cada jugador de la mesa en tres pasos y contesta si todos
// pagaron. Contrato: `2026-10-05-dinero-mock-resultados-y-reportes-design` (games-orchestrator).
//
// NADA DE ESTO SE REINTENTA desde acá. Una llamada que se perdió pudo haber cobrado; el orquestador es
// idempotente por mesa y por paso, pero el que decide reintentar un cobro es él, que ve el registro
// contable. Del lado de dominó, "no sé si pagaron" se trata igual que "no pagaron": la mesa no
// arranca, el aumento no vale, y el orquestador devuelve lo que haya cobrado.

// CUÁNTO ESPERA EL DOMINÓ CADA COBRO, y es lo que le PROMETE al orquestador en `x-charge-deadline`
// (el instante en que deja de esperar: ahora + esto). Un solo número por cobro para los tres lugares
// que lo usan —el plazo del header, el `AbortSignal` del cliente HTTP y el `withTimeout` del aumento—:
// si el orquestador terminara un cobro después de que el dominó se rindió, cobraría una mesa que el
// dominó ya dio por no cobrada. Con el plazo en la mano, el orquestador no arranca (o revierte) lo que
// no llega a contestar a tiempo.
//
// La ENTRADA espera menos: la mesa entera está mirando la pantalla de arranque. El AUMENTO, el techo de
// v1 (15 s): el que espera es un jugador que ya apretó «acepto», con la mesa diciendo x2.
export const ENTRY_CHARGE_TIMEOUT_MS = 10_000;
export const BET_CHARGE_TIMEOUT_MS = 15_000;
export const CHARGE_DEADLINE_HEADER = "x-charge-deadline";

/** El orquestador contestó que alguno no pudo pagar (`409`). Ya devolvió lo que cobró. */
export class ChargeRejectedError extends Error {
  constructor(readonly code: string) {
    super(`el orquestador rechazó el cobro: ${code}`);
    this.name = "ChargeRejectedError";
  }
}

/** No se pudo preguntar, o no contestó a tiempo. Para la mesa es lo mismo que un rechazo. */
export class OrchestratorUnavailableError extends Error {
  constructor(cause: string) {
    super(`el orquestador no contestó el cobro: ${cause}`);
    this.name = "OrchestratorUnavailableError";
  }
}

export interface OrchestratorCharges {
  /**
   * La entrada de todos los asientos, con la mesa completa y antes de arrancar.
   * @throws {ChargeRejectedError} @throws {OrchestratorUnavailableError}
   */
  chargeEntry(matchId: string): Promise<void>;
  /**
   * Un aumento acordado. `step` es el número de aumento acordado en esta mesa, desde 0: dos
   * aumentos de la misma mesa (uno revocado y otro después) no comparten clave.
   * @throws {ChargeRejectedError} @throws {OrchestratorUnavailableError}
   */
  chargeBet(matchId: string, step: number, level: number): Promise<void>;
}

export interface OrchestratorBetChargerDeps {
  readonly orchestrator: OrchestratorCharges;
  readonly timeoutMs: number;
  readonly log: Logger;
}

/**
 * LOS DOS FINALES DEL COBRO, que el motor expone hacia afuera (`EngineGraph.confirmMultiplier` /
 * `revokeMultiplier`). Los dos son idempotentes y devuelven vacío si la mesa ya no tenía un aumento
 * aceptado esperando.
 */
export interface BetChargeSettlement {
  readonly confirm: () => readonly NetworkMatchEvent[];
  readonly revoke: () => readonly NetworkMatchEvent[];
}

/**
 * EL COBRO DEL AUMENTO EN UNA MESA DEL ORQUESTADOR. Un sink que arranca el trabajo con cada
 * `MULTIPLIER_AGREED` y le dice al motor cómo terminó: cobrado (`confirm`, recién ahí el aumento sube a
 * la mesa) o no (`revoke`). Sin ledger ni billetera: los dos son del orquestador.
 */
export class OrchestratorBetCharger {
  constructor(private readonly deps: OrchestratorBetChargerDeps) {}

  /**
   * @returns el sink, y `settled`: resuelve cuando el cobro en vuelo terminó —confirmado, o ya
   * anulado—. El resultado de la partida lo espera antes de leer el aumento del estado: leído antes,
   * un aumento que todavía se estaba cobrando no contaría aunque los dos lo hayan pagado.
   */
  sinkFor(
    matchId: string,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    settle: BetChargeSettlement,
  ): { readonly sink: MatchEventSink; readonly settled: () => Promise<void> } {
    // EL CONTADOR ES DE LA MESA Y CUENTA LOS COBROS PEDIDOS, también los que después se anularon: es
    // lo que hace que el segundo aumento de una partida no reuse la clave del primero. Uno que no
    // cuesta nada no se le pide al orquestador, así que no gasta un número.
    let step = 0;
    // Uno solo a la vez: el segundo aumento se acuerda recién con el primero terminado. `collect` no
    // rechaza nunca.
    let inFlight: Promise<void> = Promise.resolve();
    const sink: MatchEventSink = (events) => {
      for (const event of events) {
        if (event.type !== "MULTIPLIER_AGREED") continue;
        if (event.additionalEntryFee.lte(ZERO)) {
          inFlight = this.finish(matchId, emit, settle, true);
          continue;
        }
        const current = step;
        step += 1;
        inFlight = this.collect(matchId, current, event.level, emit, settle);
      }
    };
    return { sink, settled: () => inFlight };
  }

  private async collect(
    matchId: string,
    step: number,
    level: number,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    settle: BetChargeSettlement,
  ): Promise<void> {
    try {
      await withTimeout(
        this.deps.orchestrator.chargeBet(matchId, step, level),
        this.deps.timeoutMs,
      );
    } catch (error: unknown) {
      // RECHAZO, ORQUESTADOR CAÍDO O SIN RESPUESTA: los tres anulan. Un aumento vale solo si quedó
      // pagado, y "no sé" no es "pagado".
      this.deps.log.warn("el orquestador no cobró el aumento; se anula", {
        matchId,
        step,
        error: String(error),
      });
      return this.finish(matchId, emit, settle, false);
    }
    return this.finish(matchId, emit, settle, true, step);
  }

  // Un final que no se puede aplicar se loguea y no se relanza: `collect` no rechaza nunca, porque el
  // resultado de la partida espera esta promesa. `step` sólo viene cuando se le pidió el cobro al
  // orquestador.
  private async finish(
    matchId: string,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    settle: BetChargeSettlement,
    paid: boolean,
    step?: number,
  ): Promise<void> {
    try {
      const events = paid ? settle.confirm() : settle.revoke();
      // COBRADO PERO SIN NADA QUE CONFIRMAR: la mesa ya había anulado el aumento (su plazo de cobro
      // venció antes). No debería pasar —el plazo de la red es más corto—, y si pasa hay plata cobrada
      // por un aumento que la mesa no cuenta: soporte tiene que verlo.
      if (paid && events.length === 0 && step !== undefined)
        this.deps.log.error("el orquestador cobró un aumento que la mesa ya no esperaba", {
          matchId,
          step,
        });
      if (events.length > 0) emit(events);
    } catch (settleError: unknown) {
      this.deps.log.error(
        paid
          ? "no se pudo confirmar el aumento cobrado"
          : "no se pudo anular el aumento no cobrado",
        { matchId, error: String(settleError) },
      );
    }
  }
}
