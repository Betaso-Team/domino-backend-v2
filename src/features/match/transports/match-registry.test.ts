import { describe, expect, it } from "vitest";
import type { DominoMatchConfig } from "../core/config.js";
import { MatchRegistry } from "./match-registry.js";

const config = {
  matchId: "m1",
  gameModeId: "clasica-2p",
  seed: "secreto-que-no-sale",
  seats: ["u1", "u2"],
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  isDealWindowEnabled: true,
} satisfies DominoMatchConfig;

describe("MatchRegistry", () => {
  it("expone solo la configuración pública de una sala", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);

    expect(registry.publicConfigOf("room-1")).toEqual({
      matchId: "m1",
      gameModeId: "clasica-2p",
      seats: ["u1", "u2"],
      pointsToWin: 100,
    });
  });

  it("nunca serializa la semilla", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);

    expect(JSON.stringify(registry.publicConfigOf("room-1"))).not.toContain("secreto-que-no-sale");
  });

  it("devuelve undefined para una sala desconocida", () => {
    expect(new MatchRegistry().publicConfigOf("room-404")).toBeUndefined();
  });

  it("encuentra la sala activa de un jugador", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);

    expect(registry.matchOf("u2")).toBe("room-1");
    expect(registry.matchOf("u9")).toBeUndefined();
  });

  it("deja de exponer una partida eliminada", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);

    registry.remove("room-1");

    expect(registry.publicConfigOf("room-1")).toBeUndefined();
    expect(registry.matchOf("u1")).toBeUndefined();
  });
});
