/**
 * The platform facts this feature produces. They travel in the same batch as a
 * match's — there is one timeline — but they are NOT broadcast to the client: the
 * balance is shown by the platform through its own channels. Their destination is
 * the history.
 *
 * The ids are primitive strings and not match's `PlayerId`: this feature imports
 * nothing from there, which is exactly what keeps it foldable into another game.
 */
export type EconomyEvent =
  | { type: "ENTRY_CHARGED"; playerId: string; amount: number; matchId: string }
  | { type: "PAYOUT_MADE"; playerId: string; amount: number; matchId: string }
  | { type: "REFUND_ISSUED"; matchId: string; playerIds: readonly string[] };
