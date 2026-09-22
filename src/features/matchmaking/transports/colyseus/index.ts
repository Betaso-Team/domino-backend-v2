// Public surface of matchmaking's Colyseus transport, towards the feature index. The gateway that
// opens matches belongs to `match`: materialising a match is that feature's, and this one is one of
// its two consumers.
export { LobbyRoom } from "./lobby-room";
export type { LobbyDeps } from "./lobby-room";
