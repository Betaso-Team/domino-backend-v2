import { Router } from "express";
import type { MaintenanceSignal } from "../../maintenance";

/** Whether the game is open, for the screen that has no session yet. */
export function maintenanceRoutes(deps: {
  readonly maintenance: Pick<MaintenanceSignal, "current">;
}): Router {
  const { maintenance } = deps;
  const router = Router();

  // THE SIGN. The other half of the maintenance — the DOOR — is in `Matchmaker.request`, and both are
  // needed: a sign the client can ignore is not an operational lever, and a closed door with no sign
  // is an error with no explanation.
  //
  // It is a route of its own and not a field on the table listing for two reasons: not breaking
  // whoever already reads that list as an array, and because maintenance does not belong to the
  // tables — it closes the whole game, tournaments included, which do not come out there.
  //
  // "Is it open?" is precisely the question one has to be able to ask before having anything to
  // authenticate with, and the answer says nothing about anyone.
  router.get("/maintenance", (_req, res) => {
    res.json(maintenance.current());
  });

  return router;
}
