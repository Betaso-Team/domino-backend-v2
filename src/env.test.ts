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
    expect(env.dealingTimeoutMs).toBe(15_000);
    expect(env.presentingRoundMs).toBe(6_000);
    expect(env.presentingMatchMs).toBe(6_000);
    expect(env.seatingTimeoutMs).toBe(30_000);
  });

  it("permite acortar los plazos desde el entorno", () => {
    const env = parseEnv({
      JWT_SECRET: "s".repeat(16),
      TURN_TIMEOUT_MS: "600",
      EXTRA_TIME_RESERVE_MS: "300",
      DEALING_TIMEOUT_MS: "800",
      PRESENTING_ROUND_MS: "120",
      PRESENTING_MATCH_MS: "130",
      SEATING_TIMEOUT_MS: "3000",
    });

    expect(env.turnTimeoutMs).toBe(600);
    expect(env.extraTimeReserveMs).toBe(300);
    expect(env.dealingTimeoutMs).toBe(800);
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

  // Ausente es un estado LEGÍTIMO y significa "esta instancia no expone /internal/*".
  // Por eso no tiene default: un default es una llave publicada.
  it("sin INTERNAL_API_KEY el entorno es válido y la llave queda indefinida", () => {
    expect(parseEnv({ JWT_SECRET: "s".repeat(16) }).internalApiKey).toBeUndefined();
  });

  it("rechaza una INTERNAL_API_KEY corta en vez de aceptar una llave enumerable", () => {
    expect(() => parseEnv({ JWT_SECRET: "s".repeat(16), INTERNAL_API_KEY: "corta" })).toThrow(
      /INTERNAL_API_KEY/,
    );
  });

  // Ausente es un estado LEGÍTIMO y significa "clúster de uno": Colyseus se queda con su driver
  // y su presence locales y el registro de partidas con el almacén de memoria. Es el mismo
  // criterio que MONGO_URI — la presencia del dato elige, sin un interruptor que la nombre.
  it("sin REDIS_URL el entorno es válido y el clúster queda en uno", () => {
    expect(parseEnv({ JWT_SECRET: "s".repeat(16) }).redisUrl).toBeUndefined();
  });

  // EL PUERTO VA COMO PATH, que es el esquema de v1: es lo que hace que el proxy que ya rutea v1
  // rutee esto sin aprender nada nuevo. Si esto se escribiera `host:puerto`, el cliente recibiría
  // en la reserva de asiento una dirección que el proxy no sabe resolver.
  it("arma la dirección pública con el puerto como path", () => {
    const env = parseEnv({
      JWT_SECRET: "s".repeat(16),
      SERVER_ADDRESS: "domino.betaso.com",
      PORT: "2568",
    });

    expect(env.publicAddress).toBe("domino.betaso.com/2568");
  });

  // Sin SERVER_ADDRESS no se anuncia NADA, y no una dirección a medias: el cliente vuelve al host
  // al que ya le habló, que es lo correcto con una instancia sola.
  it("sin SERVER_ADDRESS no anuncia ninguna dirección", () => {
    expect(parseEnv({ JWT_SECRET: "s".repeat(16) }).publicAddress).toBeUndefined();
  });

  it("rechaza un NODE_ENV fuera del enum", () => {
    expect(() => parseEnv({ JWT_SECRET: "s".repeat(16), NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
