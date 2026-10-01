import { Router } from "express";
import type { PolledCensus } from "../../live-matches";

/** How many are playing, for the screen that cannot listen to the lobby. */
export function censusRoutes(deps: { readonly census: Pick<PolledCensus, "current"> }): Router {
  const { census } = deps;
  const router = Router();

  // HOW MANY ARE PLAYING. The same number the lobby broadcasts, for the screen that cannot listen to
  // it.
  //
  // ONE field and not the banner's three, because the other two are only knowable inside the process
  // holding the lobby, and an HTTP request lands on whichever process the balancer picked.
  //
  // It counts SEATS in live matches and not sockets, tournaments included, so it does not match the
  // number v1 served under another name — which is exactly why it is not served under that name.
  router.get("/players-in-match", (_req, res) => {
    res.json({ playersInMatch: census.current().playersInMatch });
  });

  return router;
}
