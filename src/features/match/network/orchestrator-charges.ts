import { withTimeout } from "@/shared/deadline";
import type { Logger } from "@/shared/logger";
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
 * EL COBRO DEL AUMENTO EN UNA MESA DEL ORQUESTADOR. Misma forma que `BetCharger` —un sink que arranca
 * el trabajo y, si no se pudo, pide al motor que anule el trato (`revokeMultiplier`)—, sin ledger ni
 * billetera: los dos son del orquestador.
 */
export class OrchestratorBetCharger {
  constructor(private readonly deps: OrchestratorBetChargerDeps) {}

  sinkFor(
    matchId: string,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    revoke: () => readonly NetworkMatchEvent[],
  ): MatchEventSink {
    // EL CONTADOR ES DE LA MESA Y CUENTA LOS ACORDADOS, también los que después se anularon: es lo
    // que hace que el segundo aumento de una partida no reuse la clave del primero.
    let step = 0;
    return (events) => {
      for (const event of events) {
        if (event.type !== "MULTIPLIER_AGREED") continue;
        if (event.additionalEntryFee <= 0) continue;
        const current = step;
        step += 1;
        void this.collect(matchId, current, event.level, emit, revoke);
      }
    };
  }

  private async collect(
    matchId: string,
    step: number,
    level: number,
    emit: (events: readonly NetworkMatchEvent[]) => void,
    revoke: () => readonly NetworkMatchEvent[],
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
      try {
        emit(revoke());
      } catch (revokeError: unknown) {
        this.deps.log.error("no se pudo anular el aumento no cobrado", {
          matchId,
          error: String(revokeError),
        });
      }
    }
  }
}
