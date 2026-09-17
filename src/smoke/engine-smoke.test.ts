import { MatchState } from "@/features/match/core/state";
import { describe, expect, it } from "vitest";
import { nextAction, requireSmokeFlag } from "./engine-smoke";

describe("engine smoke", () => {
  it("se niega a correr sin flag", () => {
    expect(() => requireSmokeFlag(false)).toThrow(/RUN_ENGINE_SMOKE=1/);
    expect(() => requireSmokeFlag(true)).not.toThrow();
  });

  it("elige jugar, robar o pasar desde el estado visible", () => {
    const state = new MatchState();
    expect(nextAction(state, "seat-1")).toBeUndefined();
  });
});
