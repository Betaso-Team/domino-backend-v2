import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const INTERNAL_KEY_HEADER = "X-Internal-Key";

const sameKey = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const requireInternalKey =
  (expected: string): RequestHandler =>
  (request, response, next) => {
    const provided = request.get(INTERNAL_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      next();
      return;
    }
    response.status(401).json({ error: "UNAUTHORIZED" });
  };
