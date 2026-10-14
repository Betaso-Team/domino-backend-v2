import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { operatorCheck } from "./operator-verifier";

const billing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PUBLIC = billing.publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE = billing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const check = operatorCheck({
  publicKeyPem: PUBLIC,
  issuer: ["betaso-games-auth", "betaso-auth"],
  audience: "domino",
});

// Como firma billing-auth el token de un operador: ES256, su emisor, la audiencia de administración.
const operatorToken = (over: jwt.SignOptions = {}, claims: Record<string, unknown> = {}) =>
  jwt.sign({ typ: "operator", roles: ["catalog"], sid: "s-1", ...claims }, PRIVATE, {
    algorithm: "ES256",
    subject: "ana",
    issuer: "betaso-games-auth",
    audience: "betaso-games-admin",
    expiresIn: "5m",
    ...over,
  });

describe("operatorCheck", () => {
  it("dice quién es el operador y sus roles", async () => {
    expect(await check(operatorToken())).toEqual({ name: "ana", roles: ["catalog"] });
  });

  it.each([
    [
      "un token de jugador (otra audiencia)",
      operatorToken({ audience: ["orchestrator", "domino"] }),
    ],
    ["un token sin typ operator", operatorToken({}, { typ: undefined })],
    ["otro emisor", operatorToken({ issuer: "otro" })],
    ["un token vencido", operatorToken({ expiresIn: "-1m" })],
    ["basura", "no-es-un-token"],
  ])("no reconoce %s", async (_name, token) => {
    expect(await check(token)).toBeUndefined();
  });
});
