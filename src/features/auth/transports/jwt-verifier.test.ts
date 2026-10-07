import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { InvalidTokenError } from "../identity";
import { JwtVerifier } from "./jwt-verifier";

const billing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const BILLING_PUBLIC = billing.publicKey.export({ type: "spki", format: "pem" }).toString();
const BILLING_PRIVATE = billing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const verifier = new JwtVerifier({
  publicKeyPem: BILLING_PUBLIC,
  issuer: "betaso-auth",
  audience: "domino",
});

// Como firma billing-auth: ES256, emisor betaso-auth y las dos audiencias.
const billingToken = (
  over: jwt.SignOptions = {},
  key = BILLING_PRIVATE,
  claims: Record<string, unknown> = { sub: "p-1", game: "domino" },
) =>
  jwt.sign(claims, key, {
    algorithm: "ES256",
    issuer: "betaso-auth",
    audience: ["orchestrator", "domino"],
    expiresIn: "1h",
    ...over,
  });

describe("JwtVerifier", () => {
  it("verifica un token ES256 de billing-auth y devuelve el usuario del sub", async () => {
    await expect(verifier.verify(billingToken())).resolves.toEqual({ userId: "p-1" });
  });

  // LA OTRA MITAD DEL CRUCE. `configOf` guarda la identidad recortada; si el verificador
  // devolviera el padding, `onJoin` compararía `"betaso "` contra `"betaso"` y rechazaría el
  // asiento de alguien que ya pagó. Las dos fronteras normalizan o ninguna sirve.
  it("normaliza los espacios de la identidad que devuelve", async () => {
    const token = billingToken({}, BILLING_PRIVATE, { sub: "  u1  ", game: "domino" });
    await expect(verifier.verify(token)).resolves.toEqual({ userId: "u1" });
  });

  it("rechaza un token ausente", async () => {
    await expect(verifier.verify(undefined)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token expirado", async () => {
    await expect(verifier.verify(billingToken({ expiresIn: "-1h" }))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("rechaza un token sin claim sub", async () => {
    const token = billingToken({}, BILLING_PRIVATE, { game: "domino" });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  // EL HS256 YA NO ENTRA, con ningún secreto: el único emisor es billing-auth y firma ES256.
  it("rechaza un HS256, aunque sea un token bien formado del backend de Betaso", async () => {
    const token = jwt.sign({ sub: "u1", game: "domino" }, "s".repeat(32), {
      algorithm: "HS256",
      issuer: "betaso-auth",
      audience: "domino",
      expiresIn: "1h",
    });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  // LA CONFUSIÓN DE ALGORITMOS: un HS256 que usa la clave PÚBLICA como secreto.
  it("rechaza un HS256 firmado con la clave pública como secreto", async () => {
    const forged = jwt.sign({ sub: "p-1", game: "domino" }, BILLING_PUBLIC, { algorithm: "HS256" });
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un ES256 de otro emisor o sin la audiencia de dominó", async () => {
    await expect(verifier.verify(billingToken({ issuer: "otro" }))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(
      verifier.verify(billingToken({ audience: "orchestrator" })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  // billing-auth firma `aud: ['orchestrator','domino']` para TODOS los juegos: la audiencia no
  // distingue el juego, el claim `game` sí. Un token de truco no puede sentar a nadie en dominó.
  it("rechaza un ES256 de otro juego o sin claim game", async () => {
    await expect(
      verifier.verify(billingToken({}, BILLING_PRIVATE, { sub: "p-1", game: "truco" })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(
      verifier.verify(billingToken({}, BILLING_PRIVATE, { sub: "p-1" })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un ES256 firmado con otra clave", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    await expect(verifier.verify(billingToken({}, other))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  // EXIGIMOS `exp`: billing-auth siempre lo pone, y un token que no vence nunca no es uno suyo.
  it("rechaza un ES256 sin exp", async () => {
    const noExp = jwt.sign({ sub: "p-1", game: "domino" }, BILLING_PRIVATE, {
      algorithm: "ES256",
      issuer: "betaso-auth",
      audience: "domino",
    });
    await expect(verifier.verify(noExp)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token alg none", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "p-1" })}.`;
    await expect(verifier.verify(none)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it.each([
    ["texto suelto", "abc"],
    ["cadena vacía", ""],
    ["header que no es JSON", `${Buffer.from("no json").toString("base64url")}.e30.firma`],
  ])("rechaza con InvalidTokenError un token malformado: %s", async (_name, token) => {
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("no expone capacidad de firmar identidades", () => {
    expect("sign" in (verifier as unknown as Record<string, unknown>)).toBe(false);
  });
});

// LA CLAVE SE VALIDA AL ARRANCAR: el constructor corre al construir el container, así que una
// clave mala tumba el arranque en vez de fallar jugador por jugador.
describe("JwtVerifier: validación de la clave de billing-auth", () => {
  const build = (publicKeyPem: string) => () =>
    new JwtVerifier({ publicKeyPem, issuer: "betaso-auth", audience: "domino" });

  it("una clave que no es un PEM revienta al construir, nombrando la variable", () => {
    expect(build("esto no es un pem")).toThrow(/BILLING_AUTH_PUBLIC_KEY/);
  });

  it("la clave PRIVADA de billing-auth revienta: dominó nunca debe poder firmar", () => {
    expect(build(BILLING_PRIVATE)).toThrow(/BILLING_AUTH_PUBLIC_KEY/);
  });

  it("una pública RSA revienta: billing-auth firma ES256", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(build(rsa)).toThrow(/BILLING_AUTH_PUBLIC_KEY/);
  });

  it("una pública EC de otra curva (P-384) revienta", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(build(p384)).toThrow(/BILLING_AUTH_PUBLIC_KEY/);
  });

  it("la pública P-256 válida sí construye", () => {
    expect(build(BILLING_PUBLIC)).not.toThrow();
  });
});
