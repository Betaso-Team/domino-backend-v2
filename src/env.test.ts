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
    expect(env.turnTimeoutMs).toBe(60_000);
    expect(env.extraTimeReserveMs).toBe(30_000);
    expect(env.presentingRoundMs).toBe(6_000);
    expect(env.presentingMatchMs).toBe(6_000);
    expect(env.seatingTimeoutMs).toBe(30_000);
  });

  it("permite acortar los plazos desde el entorno", () => {
    const env = parseEnv({
      JWT_SECRET: "s".repeat(16),
      TURN_TIMEOUT_MS: "600",
      EXTRA_TIME_RESERVE_MS: "300",
      PRESENTING_ROUND_MS: "120",
      PRESENTING_MATCH_MS: "130",
      SEATING_TIMEOUT_MS: "3000",
    });

    expect(env.turnTimeoutMs).toBe(600);
    expect(env.extraTimeReserveMs).toBe(300);
    expect(env.presentingRoundMs).toBe(120);
    expect(env.presentingMatchMs).toBe(130);
    expect(env.seatingTimeoutMs).toBe(3_000);
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

  it("rechaza un NODE_ENV fuera del enum", () => {
    expect(() => parseEnv({ JWT_SECRET: "s".repeat(16), NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
