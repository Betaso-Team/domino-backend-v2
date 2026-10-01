// The shared HTTP seam, which has TWO halves worth not confusing:
//
//   INBOUND   validate a route's body and answer the errors nobody handled;
//   OUTBOUND  call someone else's service with a deadline and turn its status into a typed error.
//
// Neither half knows a feature.
export { validated } from "./validated";
// Exported so a feature that owns a credential can build a route on top of the validator without
// rewriting it. `shared` still knows no feature: what travels out are the shapes, not a direction.
export type { RouteSchemas, Validated } from "./validated";
export { httpErrorHandler } from "./error-handler";
export { exposeServerTime } from "./server-time";
export { HttpClient, HttpError } from "./client";
export { healthRoutes } from "./health";
export type { HttpClientOptions } from "./client";
