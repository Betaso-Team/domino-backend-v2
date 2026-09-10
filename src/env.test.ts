import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("acepta un entorno completo", () => {
    const env = parseEnv({ NODE_ENV: "production", PORT: "3000", JWT_SECRET: "s".repeat(16) });
    expect(env.port).toBe(3000);
    expect(env.nodeEnv).toBe("production");
    expect(env.jwtSecret).toBe("s".repeat(16));
  });

  it("aplica los defaults de desarrollo", () => {
    const env = parseEnv({ JWT_SECRET: "s".repeat(16) });
    expect(env.nodeEnv).toBe("development");
    expect(env.port).toBe(2567);
    expect(env.logLevel).toBe("debug");
  });

  it("en producción el nivel de log baja a info", () => {
    const env = parseEnv({ NODE_ENV: "production", JWT_SECRET: "s".repeat(16) });
    expect(env.logLevel).toBe("info");
  });

  it("rechaza un entorno sin JWT_SECRET", () => {
    expect(() => parseEnv({})).toThrow(/JWT_SECRET/);
  });

  it("rechaza un JWT_SECRET corto", () => {
    expect(() => parseEnv({ JWT_SECRET: "corto" })).toThrow(/JWT_SECRET/);
  });

  it("rechaza un PORT que no es número", () => {
    expect(() => parseEnv({ JWT_SECRET: "s".repeat(16), PORT: "abc" })).toThrow(/PORT/);
  });
});
