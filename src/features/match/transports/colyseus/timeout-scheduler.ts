import type { Delayed } from "colyseus";
import type { TimeoutScheduler } from "../../core/engine/timeout-scheduler";
import type { MatchEvent } from "../../core/events";

interface TimeoutClock {
  setTimeout(fn: () => void, ms: number): Delayed;
}

/**
 * LA SALA PUEDE CORTAR ANTES DEL MOTOR. Al vencer el plazo pregunta `shouldInterrupt`; si dice que sí
 * el vencimiento no corre y se llama `interrupt`. Es para el jugador que el reloj iba a retirar
 * cuando su caída fue culpa del servidor: la partida se cancela en vez de perderse, y como el motor
 * nunca ve ese vencimiento, el historial queda como el de un apagado y el replay lo rebobina igual.
 */
export interface TimeoutInterruption {
  shouldInterrupt(): boolean;
  interrupt(): void;
}

export class RoomTimeoutScheduler implements TimeoutScheduler {
  private timer?: Delayed;

  constructor(
    private readonly clock: TimeoutClock,
    private readonly emit: (events: readonly MatchEvent[]) => void,
    private readonly interruption?: TimeoutInterruption,
  ) {}

  schedule(at: number, onExpire: () => readonly MatchEvent[]): void {
    this.cancel();
    this.timer = this.clock.setTimeout(
      () => {
        if (this.interruption?.shouldInterrupt()) this.interruption.interrupt();
        else this.emit(onExpire());
      },
      Math.max(0, at - Date.now()),
    );
  }

  cancel(): void {
    this.timer?.clear();
    this.timer = undefined;
  }
}

// Adaptador tonto: no conoce el motor ni para qué sirve el timeout. Hay un solo timer de
// fase, reemplazado en cada schedule; recibir un instante absoluto hace la operación
// idempotente aunque la sala reprograme el mismo vencimiento.
