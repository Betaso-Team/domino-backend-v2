import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { InvalidTokenError } from "../identity";
import { JwtVerifier } from "./jwt-verifier";

const SECRET = "s".repeat(32);
const verifier = new JwtVerifier(SECRET);

describe("JwtVerifier", () => {
  it("verifica un token HS256 y devuelve el usuario del sub", async () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });

    await expect(verifier.verify(token)).resolves.toEqual({ userId: "u1" });
  });

  // LA OTRA MITAD DEL CRUCE. `configOf` guarda la identidad recortada; si el verificador
  // devolviera el padding, `onJoin` compararía `"betaso "` contra `"betaso"` y rechazaría el
  // asiento de alguien que ya pagó. Las dos fronteras normalizan o ninguna sirve.
  it("normaliza los espacios de la identidad que devuelve", async () => {
    const token = jwt.sign({ sub: "  u1  " }, SECRET, {
      algorithm: "HS256",
    });

    await expect(verifier.verify(token)).resolves.toEqual({ userId: "u1" });
  });

  it("rechaza un token ausente", async () => {
    await expect(verifier.verify(undefined)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const token = jwt.sign({ sub: "u1" }, "x".repeat(32), {
      algorithm: "HS256",
    });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token expirado", async () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "-1h",
    });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza el algoritmo none", async () => {
    const token = jwt.sign({ sub: "u1" }, "", { algorithm: "none" });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza HS384 aunque use el secreto correcto", async () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, { algorithm: "HS384" });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token sin claim sub", async () => {
    const token = jwt.sign({ role: "player" }, SECRET, {
      algorithm: "HS256",
    });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("no expone capacidad de firmar identidades", () => {
    expect("sign" in (verifier as unknown as Record<string, unknown>)).toBe(false);
  });
});
