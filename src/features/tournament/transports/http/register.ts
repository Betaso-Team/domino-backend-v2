import type { TokenVerifier } from "@/features/auth";
import { Router } from "express";
import type { StrikeBook } from "../../penalty";
import { penaltyRoutes } from "./penalty";

export interface TournamentHttpDeps {
  readonly strikes: Pick<StrikeBook, "penaltyOf">;
  readonly verifier: TokenVerifier;
}

/**
 * The tournament's inbound HTTP. Paths are absolute, so the router is mounted at
 * the root.
 */
export function tournamentHttp(deps: TournamentHttpDeps): Router {
  return Router().use(penaltyRoutes(deps));
}
