import { InvariantViolationError } from "../core/engine/errors.js";
import type { NetworkMatchEvent } from "./events.js";

// Reacciona DESPUÉS y solo PRODUCE: no puede rechazar nada. Es una de las dos
// costuras del anillo; la otra es la admisión, que decide antes y sí puede rechazar.
export type MatchEventListener = (event: NetworkMatchEvent) => readonly NetworkMatchEvent[];

// Consume y no produce: difundir, persistir el historial.
export type MatchEventSink = (events: readonly NetworkMatchEvent[]) => void;

export class MatchEventNotifier {
  // Superarlo no es "quedó corto", es un ciclo.
  private static readonly MAX_CASCADE = 10;

  constructor(
    private readonly listeners: readonly MatchEventListener[],
    private readonly broadcast: MatchEventSink,
    private readonly sinks: readonly MatchEventSink[],
  ) {}

  // El ORDEN de los pasos garantiza tres propiedades sin programarlas: el dominio
  // se publica primero y tal cual entró; al cliente no le llega nada que produjeran
  // los listeners; y un efecto de plataforma que falle no puede tapar lo del dominio,
  // porque ya salió.
  notify(events: readonly NetworkMatchEvent[]): void {
    if (events.length === 0) return;

    this.broadcast(events);
    for (const sink of this.sinks) sink(events);

    let pending = [...events];
    let rounds = 0;
    while (pending.length > 0) {
      rounds += 1;
      if (rounds > MatchEventNotifier.MAX_CASCADE) {
        throw new InvariantViolationError(
          `cascada de listeners superó ${MatchEventNotifier.MAX_CASCADE} rondas: hay un ciclo`,
        );
      }
      const produced: NetworkMatchEvent[] = [];
      for (const event of pending) {
        for (const listener of this.listeners) produced.push(...listener(event));
      }
      if (produced.length > 0) for (const sink of this.sinks) sink(produced);
      pending = produced;
    }
  }
}
