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
  // SIN TOLERANCIA A LOS TOKENS DE ANTES: `prv` y `role` son obligatorios. Un token que no los trae
  // no es «Betaso Games, admin»: es uno que no dice quién es.
  it.each([
    ["sin prv ni role", {}],
    ["sin prv", { role: "admin" }],
    ["sin role", { prv: null }],
    ["un operador sin role", { prv: "parley" }],
  ])("rechaza un token %s", async (_name, claims) => {
    expect(await check(adminToken({}, claims))).toBeUndefined();
  });

  it.each([
    ["prv nulo y rol admin", { prv: null, role: "admin" }, { provider: null, role: "admin" }],
    ["prv nulo y rol support", { prv: null, role: "support" }, { provider: null, role: "support" }],
    ["un operador admin", { prv: "parley", role: "admin" }, { provider: "parley", role: "admin" }],
    [
      "un operador support",
      { prv: "parley", role: "support" },
      { provider: "parley", role: "support" },
    ],
  ])("lee el ámbito: %s", async (_name, claims, expected) => {
    expect(await check(adminToken({}, claims))).toEqual({ name: "ana", ...expected });
  });

  // UN VALOR PRESENTE QUE NO SE ENTIENDE NO ES EL DEFAULT: es un token de otro contrato, y leerlo como
  // Betaso Games con rol admin sería darle de más justo al que no se sabe quién es.
  it.each([
    ["un rol desconocido", { prv: null, role: "superadmin" }],
    ["un rol que no es texto", { prv: null, role: 1 }],
    ["un prv vacío", { prv: "", role: "admin" }],
    ["un prv que no es texto", { prv: 42, role: "admin" }],
  ])("rechaza %s", async (_name, claims) => {
    expect(await check(adminToken({}, claims))).toBeUndefined();
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
