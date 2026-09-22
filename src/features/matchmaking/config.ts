// Matchmaking's configuration. Every number here is tuning product will want to move: with a thin
// pool it pays to loosen the veto and wait less; with a healthy one, the opposite.

export interface MatchmakingConfig {
  // How often the matcher looks at the queues. Not a perceptible latency: the point is not to walk
  // the pools on every enqueue, which with N simultaneous requests would be N walks over the same
  // state, all reaching the same conclusion.
  readonly tickIntervalMs: number;

  // How long a player waits before the server gives up. Without it, someone alone at their table
  // waits indefinitely.
  readonly searchTimeoutMs: number;

  // How long someone tolerates waiting for a non-vetoed rival before the veto stops applying. It is
  // the system's hard guarantee: **a veto can never prevent playing, only delay it**. With a healthy
  // pool it is never reached — a non-vetoed player turns up long before.
  readonly vetoBypassMs: number;

  // How many of those waiting are considered when forming a group. Searching for a veto-free group
  // among everyone waiting is a clique problem and is not worth it: the front of the queue is who
  // waited longest and who has to be served. At 12 with four-seat tables that is 495 combinations,
  // which is nothing, and with a full queue looking further would not change who gets paired.
  readonly groupingCandidates: number;

  // How many times a pair may repeat by explicit agreement before the antifraude cuts the chain. At
  // 1 it means the original match plus ONE rematch. It lives with matchmaking and not with the match
  // because it is of the same family as the cooldown and the veto — the three do-not-repeat-a-rival
  // rules — and because the same switch governs it: off, it does not apply.
  readonly maxRematchesPerChain: number;

  // How often the maintenance switch is looked at. It is the LEVER'S LATENCY: how long the front
  // takes to learn the game closed, and how long those already queued take to be let out. It cannot
  // be lazy — product pulls this when things have to stop now — and it need not be aggressive
  // either: whoever asks for a match in between already runs into the door, which waits for nobody.
  //
  // Three seconds is 0.33 reads per second. For comparison, a single player waiting in the queue
  // already costs 4 per second, because the tick rebuilds the scope's spec every 250 ms and that goes
  // to the catalog.
  readonly maintenancePollMs: number;

  // How often the count of who is playing is refreshed. Slower than the switch and for the opposite
  // reason: nobody decides anything with this number, so being a few seconds old costs nothing, while
  // taking it is expensive — it walks the cluster's whole census and sweeps the rooms that died.
  //
  // It matches the beat at which the lobby publishes its banner, so the number a client sees is never
  // older than one pulse.
  readonly censusPollMs: number;
}

const SECONDS = 1_000;

export const DEFAULT_MATCHMAKING_CONFIG: MatchmakingConfig = {
  tickIntervalMs: 250,
  searchTimeoutMs: 120 * SECONDS,
  vetoBypassMs: 20 * SECONDS,
  groupingCandidates: 12,
  maxRematchesPerChain: 1,
  maintenancePollMs: 3 * SECONDS,
  censusPollMs: 5 * SECONDS,
};
