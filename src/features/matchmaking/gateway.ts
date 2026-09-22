import type { MatchOpener, Seat } from "@/features/match";

// WHAT MATCHMAKING NEEDS from whoever materialises matches: opening them, and returning to their
// match whoever is already playing.
//
// Opening is not this feature's: `match` declares it, because matchmaking stopped being its only
// client the day the rematch opened matches too. What stays here is what does belong to this feature
// — `rejoin`, which exists because of SINGLE SESSION — plus the name the matcher asks for it by.
//
// The verb is "open a match" and not "reserve a seat" on purpose: reserving is the transport's
// vocabulary, and these ports exist precisely so matchmaking does not speak it.

export type { Seat } from "@/features/match";

export interface MatchGateway extends MatchOpener {
  /**
   * RETURNING to a match that already exists: the seat of whoever is still playing
   * in it. This is what turns single session into a way back rather than a
   * refusal — whoever reopens the app needs to have saved nothing, asking for a
   * match is enough.
   *
   * @throws when there is no seat to give, the normal case being that the match is
   * FULL because the player is still connected from somewhere else. There the
   * refusal is the right answer.
   */
  rejoin(roomId: string, playerId: string): Promise<Seat>;
}
