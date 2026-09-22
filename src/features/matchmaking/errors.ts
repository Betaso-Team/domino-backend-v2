/**
 * WHY the pairing failed. A closed union and not a loose string for the same reason
 * as `AbortReason`: the client draws a different screen for each case, and a new
 * reason has to force a decision about what is shown instead of slipping in as
 * text.
 *
 * These are reasons of the MATCHMAKING PHASE and not of a match, which does not
 * exist yet.
 */
export type MatchmakingErrorReason =
  /** The token is not valid. Rarely seen here: the lobby door already verified it on the way in. */
  | "UNAUTHORIZED"
  /** The table or tournament asked for does not exist — a stale id the client had cached. */
  | "POOL_NOT_FOUND"
  /** It exists but is not accepting people: a table switched off, a tournament not in play. */
  | "POOL_CLOSED"
  /**
   * The whole game is closed for maintenance. Distinct from `POOL_CLOSED` because
   * it is not the table that is off but the server, and the client shows another
   * screen: the "back in a while" one, with the message the admin panel wrote.
   */
  | "MAINTENANCE"
  /**
   * They cannot afford the entry fee. Answered HERE and not after pairing them,
   * which would drag the rival into a match that opened and closed by itself.
   */
  | "INSUFFICIENT_FUNDS"
  /** Tournament: not enrolled. The main backend rules on that. */
  | "NOT_ENROLLED"
  /** Tournament: they are carrying a penalty for walkouts and still serving it. */
  | "PENALIZED"
  /** The search timed out with no rivals found. */
  | "TIMEOUT"
  /**
   * El servidor se está apagando y la búsqueda no se puede trasladar: la cola vive en el proceso que
   * cierra. Motivo propio y no `INTERNAL` porque es el ÚNICO caso en que no falló nada y volver a
   * pedir funciona: el cliente reintenta cuando vuelva en vez de mostrar un error que no puede
   * resolver. Portado de truco (`10cdd0e`).
   */
  | "RESTARTING"
  /** They left: cancelled or dropped out of the lobby. Not a failure, but it closes the request. */
  | "CANCELLED"
  /**
   * They are already in another match and their seat could not be given back — the
   * normal case being that they are still connected from another device, so their
   * table is full. This is the SINGLE SESSION rule, and this error is what is left
   * when even returning them is impossible.
   */
  | "ALREADY_IN_MATCH"
  /**
   * Anything else. The catch-all, and the only one that says nothing useful: if
   * something comes out of here often, it is missing a reason of its own.
   */
  | "INTERNAL";

export class MatchmakingError extends Error {
  constructor(
    readonly reason: MatchmakingErrorReason,
    message = "",
  ) {
    super(message || reason);
    this.name = "MatchmakingError";
  }
}
