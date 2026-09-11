// src/features/match/core/engine/tests/state-projections.test.ts
import { describe, expect, it } from "vitest";
import { BoardState, BoneyardState, MatchState, RoundState } from "../../state/index.js";
import { InvariantViolationError } from "../errors.js";
import { createMatchState } from "../genesis.js";
import {
  currentRoundOf,
  handOf,
  isRoundActive,
  opponentTeam,
  playerOf,
  scoreboardOf,
  teamOf,
  turnOrderFrom,
} from "../state-projections.js";

// SEAT_ORDER y no SHUFFLED, a propósito: este test prueba las PROYECCIONES, no el sorteo.
// Con SHUFFLED las aserciones de abajo (u1→A, u2→B, u3→A) dependerían de que la permutación
// del seed "s" resulte ser la identidad — o sea que pasarían por casualidad, y se romperían
// el día que alguien toque el PRNG. El sorteo tiene su propio test en el Step 0a.
const build = (seats = ["u1", "u2"]) =>
  createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats,
    pointsToWin: 100,
    teamAssignment: "SEAT_ORDER",
    isDealWindowEnabled: false,
  });

describe("proyecciones puras del estado", () => {
  it("teamOf mapea asiento a equipo", () => {
    const match = build(["u1", "u2", "u3", "u4"]);
    expect(teamOf("u1", match)).toBe("A");
    expect(teamOf("u2", match)).toBe("B");
    expect(teamOf("u3", match)).toBe("A");
  });

  it("playerOf lanza una invariante si el jugador no tiene asiento", () => {
    const match = build();
    expect(() => playerOf("intruso", match)).toThrow(InvariantViolationError);
  });

  it("currentRoundOf estrecha el opcional afirmando la invariante", () => {
    const match = build();
    expect(() => currentRoundOf(match)).toThrow(InvariantViolationError);

    const round = new RoundState();
    round.roundNumber = 1;
    round.board = new BoardState();
    round.boneyard = new BoneyardState();
    match.currentRound = round;
    expect(currentRoundOf(match).roundNumber).toBe(1);
  });

  // A diferencia de `currentRound`, la génesis SIEMPRE instancia `scoreboard` (Step 3), así
  // que la rama que lanza no se ve pasando por `build()` — hay que construir un MatchState
  // pelado para reproducirla, tal como quedaría un árbol si la génesis dejara de hacerlo.
  it("scoreboardOf estrecha el opcional afirmando la invariante", () => {
    expect(() => scoreboardOf(new MatchState())).toThrow(InvariantViolationError);

    const match = build();
    expect(scoreboardOf(match).teamA).toBe(0);
  });

  it("isRoundActive es falso para quien abandonó", () => {
    const match = build();
    const player = playerOf("u1", match);
    expect(isRoundActive(player)).toBe(true);
    player.hasAbandoned = true;
    expect(isRoundActive(player)).toBe(false);
  });

  it("opponentTeam invierte, porque solo hay dos equipos", () => {
    expect(opponentTeam("A")).toBe("B");
    expect(opponentTeam("B")).toBe("A");
  });

  it("turnOrderFrom recorre los asientos en ciclo desde uno dado", () => {
    const match = build(["u1", "u2", "u3", "u4"]);
    expect(turnOrderFrom("u3", match).map((p) => p.playerId)).toEqual(["u3", "u4", "u1", "u2"]);
  });

  it("handOf devuelve las fichas del asiento", () => {
    const match = build();
    expect(handOf("u1", match).tiles.length).toBe(0);
  });
});
