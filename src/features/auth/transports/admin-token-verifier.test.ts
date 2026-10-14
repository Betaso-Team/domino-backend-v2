import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { adminTokenCheck } from "./admin-token-verifier";

const billing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PUBLIC = billing.publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE = billing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const check = adminTokenCheck({
  publicKeyPem: PUBLIC,
  issuer: "betaso-games-auth",
  audience: "domino",
});

// Como firma billing-auth el token de un admin: ES256, su emisor, la audiencia de administración.
const adminToken = (over: jwt.SignOptions = {}, claims: Record<string, unknown> = {}) =>
  jwt.sign({ typ: "admin", sid: "s-1", ...claims }, PRIVATE, {
    algorithm: "ES256",
    subject: "ana",
    issuer: "betaso-games-auth",
    audience: "betaso-games-admin",
    expiresIn: "5m",
    ...over,
  });

describe("adminTokenCheck", () => {
  it("dice quién es el admin", async () => {
    expect(await check(adminToken())).toEqual({ name: "ana" });
  });

  it.each([
    ["un token de jugador (otra audiencia)", adminToken({ audience: ["orchestrator", "domino"] })],
    ["un token sin typ admin", adminToken({}, { typ: undefined })],
    ["un token de operador, del modelo con roles", adminToken({}, { typ: "operator" })],
    ["otro emisor", adminToken({ issuer: "otro" })],
    ["un token vencido", adminToken({ expiresIn: "-1m" })],
    ["basura", "no-es-un-token"],
  ])("no reconoce %s", async (_name, token) => {
    expect(await check(token)).toBeUndefined();
  });
});
