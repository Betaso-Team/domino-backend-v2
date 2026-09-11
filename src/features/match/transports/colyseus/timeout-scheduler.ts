import type { Delayed } from "colyseus";
import type { TimeoutScheduler } from "../../core/engine/timeout-scheduler.js";
import type { MatchEvent } from "../../core/events.js";

interface TimeoutClock {
  setTimeout(fn: () => void, ms: number): Delayed;
}

export class RoomTimeoutScheduler implements TimeoutScheduler {
  private timer?: Delayed;

  constructor(
    private readonly clock: TimeoutClock,
    private readonly emit: (events: readonly MatchEvent[]) => void,
  ) {}

  schedule(at: number, onExpire: () => readonly MatchEvent[]): void {
    this.cancel();
    this.timer = this.clock.setTimeout(() => this.emit(onExpire()), Math.max(0, at - Date.now()));
  }

  cancel(): void {
    this.timer?.clear();
    this.timer = undefined;
  }
}

// Adaptador tonto: no conoce el motor ni para qué sirve el timeout. Hay un solo timer de
// fase, reemplazado en cada schedule; recibir un instante absoluto hace la operación
// idempotente aunque la sala reprograme el mismo vencimiento.
