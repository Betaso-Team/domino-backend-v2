import type { MatchEvent } from "../events";

// Puerto de SALIDA. El engine, al final de cada transición, le pasa el instante vigente
// y —por callback opaco— la transición a correr al vencer. La infraestructura solo espera
// y difunde: no lee fases ni deadlines.
export interface TimeoutScheduler {
  schedule(at: number, onExpire: () => readonly MatchEvent[]): void;
  cancel(): void;
}
