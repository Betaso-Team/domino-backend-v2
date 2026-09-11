import type { MatchHistory } from "./history.js";
import type { MatchEventListener, MatchEventSink } from "./listeners.js";

// Lo que el wiring le entrega a la sala. La sala no arma nada de esto: solo lo usa.
export interface MatchPieces {
  readonly history: MatchHistory;
  readonly listeners: readonly MatchEventListener[];
  readonly sinks: readonly MatchEventSink[];
}
