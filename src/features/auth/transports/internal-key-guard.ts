import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { INTERNAL_API_KEY_HEADER, type InternalApiKey } from "../internal-key";

/**
 * The INBOUND half of the internal key: the door that demands it.
 *
 * The distinction with the bearer guard runs deep: a player's token says WHO is
 * speaking, and out of it comes a `userId` that matters afterwards. An internal key
 * says nobody: it says **whoever speaks is an authorised server**, and there is no
 * identity to extract. That is why it hangs nothing off `req`, and why the routes
 * it protects cannot audit a person.
 *
 * **Constant-time comparison.** A `===` over a credential leaks its length and its
 * prefix through the response time. Over a network with jitter the attack is
 * impractical, but `timingSafeEqual` costs nothing and is the correct primitive.
 */
export function requireInternalKey(expected: InternalApiKey): RequestHandler {
  const valid = Buffer.from(expected.value);
  return (req, res, next) => {
    const header = req.headers[INTERNAL_API_KEY_HEADER];
    const given = typeof header === "string" ? Buffer.from(header) : undefined;
    // The length is compared first and outside constant time on purpose: `timingSafeEqual` THROWS on
    // buffers of different sizes, so there is no way not to look at it. What is protected is the
    // content, which is what cannot be guessed a byte at a time.
    if (!given || given.length !== valid.length || !timingSafeEqual(given, valid)) {
      res.status(401).json({ code: "UNAUTHORIZED" });
      return;
    }
    next();
  };
}
