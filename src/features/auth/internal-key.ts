// The OTHER half of authentication: what the truco presents when the one asking is itself and not a
// player. The main backend demands it on its internal routes.
//
// It lives here and not inside each HTTP client so the header's name is written ONCE: it is a
// contract with the other side, and repeating it in every transport is how one ends up with two
// spellings and a 401 nobody explains.
//
// The distinction with a player's token runs deep and is worth keeping in mind: with the API key the
// question is "what do you know about this tournament?"; with the player's token it is "is the one
// connecting enrolled?". Answering the second with server credentials would turn it into "is someone
// with this id enrolled?", which is not the same.

export const INTERNAL_API_KEY_HEADER = "x-internal-api-key";

export interface InternalApiKey {
  readonly value: string;
}

export function internalAuthHeaders({ value }: InternalApiKey): Record<string, string> {
  return { [INTERNAL_API_KEY_HEADER]: value };
}
