import type { Application } from "express";
import type { PolledCensus } from "../../live-matches";
import type { MaintenanceSignal } from "../../maintenance";

/**
 * Matchmaking's HTTP transport: the two things the lobby screen needs to know
 * BEFORE anyone has logged in.
 *
 * Both are served WITHOUT A TOKEN, which is the whole reason they exist as routes
 * instead of lobby messages: the screen that asks is the one with no session, and
 * it cannot join a room whose door verifies a JWT. And for that same reason both
 * are served FROM MEMORY — with no credential, a route that queried the store on
 * every call is an amplifier anyone can pull.
 */
export function registerMatchmakingHttp(
  app: Application,
  maintenance: Pick<MaintenanceSignal, "current">,
  census: Pick<PolledCensus, "current">,
): void {
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
  app.get("/maintenance", (_req, res) => {
    res.json(maintenance.current());
  });

  // HOW MANY ARE PLAYING. The same number the lobby broadcasts, for the screen that cannot listen to
  // it.
  //
  // ONE field and not the banner's three, because the other two are only knowable inside the process
  // holding the lobby, and an HTTP request lands on whichever process the balancer picked.
  //
  // It counts SEATS in live matches and not sockets, tournaments included, so it does not match the
  // number v1 served under another name — which is exactly why it is not served under that name.
  app.get("/players-in-match", (_req, res) => {
    res.json({ playersInMatch: census.current().playersInMatch });
  });
}
