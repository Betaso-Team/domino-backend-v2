import { defineRoom } from "colyseus";
import { type LobbyDeps, LobbyRoom } from "./lobby-room";

/**
 * The feature's rooms, as its slice of the server's room map — the same shape its
 * HTTP transport has (truco `597e5af`). It TAKES what it needs instead of
 * resolving it from a container. Not ceremony: the container builds the matcher,
 * so a lobby resolving it from there would make the container depend on the room
 * and the room on the container.
 */
export function matchmakingRooms(deps: LobbyDeps) {
  return { lobby: defineRoom(LobbyRoom, deps) };
}
