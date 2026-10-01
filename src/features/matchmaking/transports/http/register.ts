import { Router } from "express";
import type { PolledCensus } from "../../live-matches";
import type { MaintenanceSignal } from "../../maintenance";
import { censusRoutes } from "./census";
import { maintenanceRoutes } from "./maintenance";

export interface MatchmakingHttpDeps {
  readonly maintenance: Pick<MaintenanceSignal, "current">;
  readonly census: Pick<PolledCensus, "current">;
}

/**
 * Matchmaking's HTTP transport: the two things the lobby screen needs to know
 * BEFORE anyone has logged in. Paths are absolute, so the router is mounted at the
 * root.
 *
 * Both are served WITHOUT A TOKEN, which is the whole reason they exist as routes
 * instead of lobby messages: the screen that asks is the one with no session, and
 * it cannot join a room whose door verifies a JWT. And for that same reason both
 * are served FROM MEMORY — with no credential, a route that queried the store on
 * every call is an amplifier anyone can pull.
 */
export function matchmakingHttp(deps: MatchmakingHttpDeps): Router {
  return Router().use(maintenanceRoutes(deps)).use(censusRoutes(deps));
}
