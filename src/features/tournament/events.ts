/**
 * The platform facts this feature produces. Like `economy`'s they travel in the
 * same batch as a match's but are NOT broadcast to the client: the standings are
 * shown by the platform through its own channels. Their destination is the history.
 *
 * The ids are primitive strings: this feature imports nothing from `match`.
 */
export type TournamentEvent =
  | {
      type: "RESULT_REPORTED";
      tournamentId: string;
      matchId: string;
      playerId: string;
      score: number;
      /**
       * Whether a WIN scored below the top of the scale. It travels because the
       * number alone is unreadable: a zero for winning looks like a bug unless
       * something says the match was too short to be worth the full points.
       *
       * Always `false` for a loss, where the scale plays no part.
       */
      reduced: boolean;
    }
  | {
      type: "STRIKE_ADDED";
      tournamentId: string;
      playerId: string;
      strikes: number;
      blockedUntil: number;
    }
  | { type: "PAIR_VETOED"; tournamentId: string; playerIds: readonly string[] };
