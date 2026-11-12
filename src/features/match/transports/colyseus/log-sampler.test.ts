import { describe, expect, it, vi } from "vitest";
import { LogSampler } from "./log-sampler";

describe("LogSampler", () => {
  it("deja pasar las primeras de la ventana, calla el resto y lo resume al abrir la siguiente", () => {
    let now = 0;
    const log = { warn: vi.fn() };
    const sampler = new LogSampler(log, () => now, 2, 1_000);

    const passed = Array.from({ length: 10 }, () =>
      sampler.warn("seat-1", "illegal", "comando ilegal", { n: 1 }),
    );
    expect(passed.filter(Boolean)).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledTimes(2);

    now = 1_000;
    sampler.warn("seat-1", "illegal", "comando ilegal", { n: 2 });
    expect(log.warn).toHaveBeenCalledWith("rechazos silenciados en el log", {
      playerId: "seat-1",
      kind: "illegal",
      silenced: 8,
      windowMs: 1_000,
    });
    expect(log.warn).toHaveBeenLastCalledWith("comando ilegal", { n: 2 });
  });

  it("cada asiento y cada clase tienen su propia cuota", () => {
    const log = { warn: vi.fn() };
    const sampler = new LogSampler(log, () => 0, 1, 1_000);
    expect(sampler.warn("seat-1", "illegal", "x", {})).toBe(true);
    expect(sampler.warn("seat-1", "illegal", "x", {})).toBe(false);
    expect(sampler.warn("seat-2", "illegal", "x", {})).toBe(true);
    expect(sampler.warn("seat-1", "malformed", "x", {})).toBe(true);
  });
});
