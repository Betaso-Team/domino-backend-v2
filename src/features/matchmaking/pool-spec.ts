import type { DominoRoomOptions } from "@/features/match";

// WHAT THE SCOPE CONTRIBUTES TO MATCHMAKING. The sibling of `MatchPieces`: the same idea — the scope
// contributes its whole edge and the rest does not know who gave it — from the other side of a match.
//
// Its reason to exist is that the matcher should not have a SINGLE branch per mode. Everything that
// differs between casual and tournament — how many sit down, to how many piedras, who may enter, who
// they would rather avoid, how the room is assembled — is in here. Adding a mode is adding one
// implementation and one line of wiring; the matcher, the queue, the gateway and the grouping stay
// untouched.

/**
 * Which pool is being asked for. A DISCRIMINATED UNION, like the room options:
 * there is no all-optional object allowing the illegal combination.
 */
export type PoolRequest =
  | { kind: "CASUAL"; gameModeId: string }
  | { kind: "TOURNAMENT"; tournamentId: string };

export interface Ticket {
  readonly playerId: string;
  /** The game mode in casual, the tournament in a tournament: the axis that separates the queues. */
  readonly poolId: string;
  /** The original request is enough to rebuild the scope if its configuration changes. */
  readonly request: PoolRequest;
  readonly enqueuedAt: number;
  /** Who they would rather not cross. A preference, never a permanent block. */
  readonly avoid: readonly string[];
}

/**
 * Who is asking. It carries the token as well as the id because one of the
 * scope's restrictions — "are you enrolled in this tournament?" — is ruled on
 * by the main backend against THAT PLAYER's own credential and not the server's
 * API key.
 */
export interface Requester {
  readonly playerId: string;
  readonly token: string;
}

export interface PoolSpec {
  readonly poolId: string;
  /**
   * How many it gathers. It comes from the catalog or from the tournament and
   * NEVER from a constant in the matcher: that is what makes opening a 2v2 a piece
   * of data.
   */
  readonly seats: number;
  readonly pointsToWin: number;

  /**
   * The scope's restrictions, resolved BEFORE queueing. This is where the price of
   * asking over the network is paid, once per request and not once per tick.
   *
   * @throws {MatchmakingError} when they may not enter.
   */
  admit(requester: Requester): Promise<void>;

  /** Who they would rather not cross. A PREFERENCE the grouping drops before leaving anyone out. */
  avoid(playerId: string): Promise<readonly string[]>;

  /**
   * How a group turns into a match. The ORDER of the tickets is already decided by
   * the grouping — and that order IS the team assignment — so this only translates.
   */
  toRoomOptions(group: readonly Ticket[], seed: string): DominoRoomOptions;
}

/** Where a pool's spec comes from. The ONLY piece of matchmaking that dispatches by mode. */
export interface PoolDirectory {
  specOf(request: PoolRequest): Promise<PoolSpec>;
}
