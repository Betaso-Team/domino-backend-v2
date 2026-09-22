import { type RouteSchemas, type Validated, validated } from "@/shared/http";
import type { RequestHandler, Response } from "express";
import { type Identity, InvalidTokenError, type TokenVerifier } from "../identity";

// Reading the credential is ONE thing, so it is written once and the two doors below share it.
const BEARER = /^bearer /i;

function tokenOf(header = ""): string | undefined {
  // The prefix is compared case-insensitively: it is what the rest of the world does with this
  // header, and a lowercase `bearer` is a correct client and not one without a credential.
  return BEARER.test(header) ? header.slice(7).trim() : undefined;
}

// The 401 does not say which of the three reasons it was. Telling "none arrived" from "it expired"
// helps the client on the socket, where the session is held; on a one-off query, saying so only
// helps whoever is trying tokens out.
function refuse(res: Response, e: unknown, next: (e?: unknown) => void): void {
  if (e instanceof InvalidTokenError) res.status(401).json({ code: "UNAUTHORIZED" });
  else next(e);
}

/**
 * THE SAME DOOR, over HTTP. The twin of the rooms' `onAuth`: what changes is where
 * the credential comes from and not what is done with it.
 *
 * It lives in this feature and not in the one that uses it because HOW a credential
 * is presented is this feature's business, as much as which algorithm checks it. An
 * endpoint that reimplements it is an endpoint that tomorrow accepts a token the
 * room would refuse.
 *
 * It is an Express middleware and not a parameter of the shared validator on
 * purpose: `shared` cannot import `features/`, and authenticating is not validating
 * the SHAPE of the input — it is a prior decision, cutting before the handler
 * exists.
 *
 * It does NOT leave the identity anywhere, because what this one requires is that
 * SOMEONE is authenticated and not who. A route that needs to know who asks takes
 * `authenticated` instead.
 */
export function requireBearer(verifier: TokenVerifier): RequestHandler {
  return (req, res, next) => {
    verifier
      .verify(tokenOf(req.headers.authorization))
      .then(() => next())
      .catch((e) => refuse(res, e, next));
  };
}

/**
 * THE SAME DOOR, for a route that answers ABOUT WHOEVER KNOCKED. Its whole
 * difference with `requireBearer` is that the identity survives the check
 * instead of being thrown away.
 *
 * It is one piece and not a middleware plus a reader because there is nowhere to
 * leave the identity in between: the validator hands the handler an already-typed
 * input and deliberately never hands it the request, so an identity travelling on
 * `req` could not be read from where it is needed — and putting it there would
 * mean widening Express's types for a value with one consumer.
 *
 * It lives in this feature for the same reason `requireBearer` does: what a
 * credential is and how it is presented is this feature's business. It knows the
 * validator but the validator does not know it, which is the direction `shared`
 * requires.
 *
 * The check runs BEFORE the shape: there is no reason to tell an anonymous caller
 * which inputs we accept.
 */
export function authenticated<S extends RouteSchemas>(
  verifier: TokenVerifier,
  schemas: S,
  handle: (identity: Identity, input: Validated<S>, res: Response) => void | Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    verifier
      .verify(tokenOf(req.headers.authorization))
      .then((identity) =>
        validated(schemas, (input, response) => handle(identity, input, response))(req, res, next),
      )
      .catch((e) => refuse(res, e, next));
  };
}
