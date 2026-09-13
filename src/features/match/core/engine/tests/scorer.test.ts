import { describe, expect, it } from "vitest";
import { createMatchState } from "../genesis.js";
import { Scorer } from "../scorer.js";
import { scoreboardOf } from "../state-projections.js";

const build = (pointsToWin = 100) =>
  createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats: ["u1", "u2"],
    pointsToWin,
    teamAssignment: "SEAT_ORDER",
    isDealWindowEnabled: false,
  });

describe("Scorer", () => {
  it("acredita los puntos al equipo del ganador", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 1, winnerId: "u1", points: 14, reason: "DOMINO" });

    expect(scoreboardOf(match).teamA).toBe(14);
    expect(scoreboardOf(match).teamB).toBe(0);
  });

  it("acredita al equipo del ganador y a nadie más", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 1, winnerId: "u2", points: 9, reason: "BLOCKED" });

    expect(scoreboardOf(match).teamB).toBe(9);
    expect(scoreboardOf(match).teamA).toBe(0);
  });

  it("acumula entre rondas", () => {
    const match = build();
    const scorer = new Scorer(match);
    scorer.credit({ roundNumber: 1, winnerId: "u1", points: 10, reason: "DOMINO" });
    scorer.credit({ roundNumber: 2, winnerId: "u1", points: 5, reason: "BLOCKED" });

    expect(scoreboardOf(match).teamA).toBe(15);
  });

  it("archiva un resumen por ronda, que es lo único que sobrevive de las pasadas", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 3, winnerId: "u1", points: 12, reason: "BLOCKED" });

    expect(match.pastRounds.length).toBe(1);
    expect(match.pastRounds.at(0)?.toJSON()).toEqual({
      roundNumber: 3,
      winnerId: "u1",
      winnerTeamId: "A",
      points: 12,
      reason: "BLOCKED",
    });
  });

  it("un empate no mueve el marcador pero deja rastro de la ronda", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 1, winnerId: undefined, points: 0, reason: "BLOCKED" });

    expect(scoreboardOf(match).teamA).toBe(0);
    expect(scoreboardOf(match).teamB).toBe(0);
    expect(match.pastRounds.length).toBe(1);
    expect(match.pastRounds.at(0)?.winnerId).toBe("");
  });
});
