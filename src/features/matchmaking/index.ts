import type { Server } from "@colyseus/core";
import { type LobbyDeps, LobbyRoom } from "./transports/colyseus";

/**
 * The feature's public surface: the two transports' registers, plus the ports,
 * the config and today's implementations the composition root needs to wire it.
 * Nothing outside reaches the inside.
 *
 * Both registers TAKE what they need instead of resolving it from a container.
 * Not ceremony: the container builds the matcher, so a lobby resolving it from
 * there would make the container depend on the room and the room on the
 * container.
 */
export function registerMatchmaking(gameServer: Server, deps: LobbyDeps): void {
  gameServer.define("lobby", LobbyRoom, deps);
}

export type { LobbyDeps } from "./transports/colyseus";
export { LobbyRoom } from "./transports/colyseus";

export { registerMatchmakingHttp } from "./transports/http";

export type { AntifraudFlag } from "./antifraud-flag";
export { CachedAntifraudFlag } from "./antifraud-flag";
export type { CooldownConfig } from "./core/cooldown";
export { CooldownBook, DEFAULT_COOLDOWN, cooldownLadder } from "./core/cooldown";
export type { MatchOrigin, MatchmakingFeedbackDeps } from "./feedback";
export { matchmakingSink } from "./feedback";
export type { VetoConfig } from "./veto";
export { CASUAL_SCOPE, VetoBook, casualVetoKey, tournamentVetoKey } from "./veto";
export type { VetoKey } from "./veto";
export type { MatchmakingConfig } from "./config";
export { DEFAULT_MATCHMAKING_CONFIG } from "./config";
export {
  MATCHMAKING_EDITABLE,
  MATCHMAKING_NOT_EDITABLE,
  matchmakingConfigPatch,
} from "./config-schema";
export type { MatchmakingErrorReason } from "./errors";
export type { Maintenance, MaintenanceBook, MaintenanceSignal } from "./maintenance";
export { OPEN, PolledMaintenanceSignal } from "./maintenance";
export { MatchmakingError } from "./errors";
export type { MatchGateway, Seat } from "./gateway";
export type { LiveCensus, LiveMatches, MatchCensus } from "./live-matches";
export { NO_ONE, PolledCensus } from "./live-matches";
export { Matchmaker } from "./matchmaker";
export type { MatchmakerDeps } from "./matchmaker";
export type { MatchPool, Ticket } from "./pool";
export type { PoolDirectory, PoolRequest, PoolSpec, Requester } from "./pool-spec";
export type { CasualPoolDeps } from "./pools/casual";
export type { TournamentPoolDeps } from "./pools/tournament";
export { ScopedPoolDirectory } from "./pools/directory";
export { MongoMaintenanceBook } from "./transports/mongo-maintenance";
export { MemoryMatchPool } from "./transports/memory-pool";
export { HttpAntifraudFlag } from "./transports/http-flag";
