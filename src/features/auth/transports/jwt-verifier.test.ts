import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { InvalidTokenError } from "../identity.js";
import { JwtVerifier } from "./jwt-verifier.js";

const SECRET = "s".repeat(32);
const verifier = new JwtVerifier(SECRET);

describe("JwtVerifier", () => {
  it("verifica un token HS256 y devuelve su identidad compuesta", async () => {
    const token = jwt.sign({ sub: "u1", platformId: "betaso" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });

    await expect(verifier.verify(token)).resolves.toEqual({
      platformId: "betaso",
      userUuid: "u1",
    });
  });

  // LA PLATAFORMA ES PARTE DE LA IDENTIDAD, no un adorno del token: sin ella el mismo
  // `sub` de dos productos distintos autoriza la misma mesa, y la mesa mueve plata.
  // `"   "` es el caso que un `typeof === "string"` pelado deja pasar y que después
  // formaría una clave de índice vacía en el registro.
  it.each<[string, Record<string, unknown>]>([
    ["sin platformId", { sub: "u1" }],
    ["con platformId vacío", { sub: "u1", platformId: "   " }],
  ])("rechaza un token %s", async (_name, payload) => {
    const token = jwt.sign(payload, SECRET, { algorithm: "HS256" });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  // LA OTRA MITAD DEL CRUCE. `configOf` guarda la identidad recortada; si el verificador
  // devolviera el padding, `onJoin` compararía `"betaso "` contra `"betaso"` y rechazaría el
  // asiento de alguien que ya pagó. Las dos fronteras normalizan o ninguna sirve.
  it("normaliza los espacios de la identidad que devuelve", async () => {
    const token = jwt.sign({ sub: "  u1  ", platformId: " betaso " }, SECRET, {
      algorithm: "HS256",
    });

    await expect(verifier.verify(token)).resolves.toEqual({
      platformId: "betaso",
      userUuid: "u1",
    });
  });

  it("rechaza un token ausente", async () => {
    await expect(verifier.verify(undefined)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const token = jwt.sign({ sub: "u1", platformId: "betaso" }, "x".repeat(32), {
      algorithm: "HS256",
    });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token expirado", async () => {
    const token = jwt.sign({ sub: "u1", platformId: "betaso" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "-1h",
    });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza el algoritmo none", async () => {
    const token = jwt.sign({ sub: "u1", platformId: "betaso" }, "", { algorithm: "none" });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza HS384 aunque use el secreto correcto", async () => {
    const token = jwt.sign({ sub: "u1", platformId: "betaso" }, SECRET, { algorithm: "HS384" });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rechaza un token sin claim sub", async () => {
    const token = jwt.sign({ role: "player", platformId: "betaso" }, SECRET, {
      algorithm: "HS256",
    });

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("no expone capacidad de firmar identidades", () => {
    expect("sign" in (verifier as unknown as Record<string, unknown>)).toBe(false);
  });
});
