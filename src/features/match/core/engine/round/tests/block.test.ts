import { describe, expect, it } from "vitest";
import { BoardState, BoneyardState, PlacedTile, RoundState, Tile } from "../../../state/index";
import { createMatchState } from "../../genesis";
import { handOf } from "../../state-projections";
import { matchConfig } from "../../tests/match-config-fixture";
import { blockVerdictOf, isBlocked } from "../block";

function build(handsBySeat: Record<string, [number, number][]>, boneyard: [number, number][] = []) {
  const seats = Object.keys(handsBySeat);
  const match = createMatchState(matchConfig(seats, { seed: "s", teamAssignment: "SHUFFLED" }));
  const round = new RoundState();
  round.roundNumber = 1;
  round.phase = "PLAYING";
  round.board = new BoardState();
  const boneyardState = new BoneyardState();
  round.boneyard = boneyardState;

  const placedTile = new Tile();
  placedTile.left = 6;
  placedTile.right = 4;
  const placed = new PlacedTile();
  placed.tile = placedTile;
  placed.playedBy = seats[0] ?? "";
  placed.side = "RIGHT";
  round.board.tiles.push(placed);

  for (const [left, right] of boneyard) {
    const tile = new Tile();
    tile.left = left;
    tile.right = right;
    boneyardState.tiles.push(tile);
  }
  boneyardState.count = boneyardState.tiles.length;
  match.currentRound = round;

  for (const [playerId, tiles] of Object.entries(handsBySeat)) {
    const hand = handOf(playerId, match);
    for (const [left, right] of tiles) {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      hand.tiles.push(tile);
    }
    hand.tileCount = hand.tiles.length;
  }
  return match;
}

describe("isBlocked", () => {
  it("no está trancado si alguien puede jugar", () => {
    expect(isBlocked(build({ u1: [[6, 1]], u2: [[3, 2]] }))).toBe(false);
  });

  it("no está trancado si el pozo contiene una ficha jugable", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }, [[6, 0]]))).toBe(false);
  });

  it("está trancado si las fichas del pozo tampoco pueden jugarse", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }, [[0, 0]]))).toBe(true);
  });

  it("está trancado si nadie puede jugar y el pozo está vacío", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }))).toBe(true);
  });

  it("una mano vacía no traba nada: eso es dominó, no tranca", () => {
    expect(isBlocked(build({ u1: [], u2: [[5, 1]] }))).toBe(false);
  });
});

describe("blockVerdictOf — reglas §3.7", () => {
  it("gana quien tiene menos puntos en la mano", () => {
    const verdict = blockVerdictOf(build({ u1: [[3, 2]], u2: [[5, 1]] }));
    expect(verdict).toEqual({ winnerId: "u1", isTie: false, points: 6 });
  });

  it("los puntos son la suma de TODAS las manos perdedoras", () => {
    const verdict = blockVerdictOf(
      build({
        u1: [[1, 0]],
        u2: [
          [5, 1],
          [4, 4],
        ],
      }),
    );
    expect(verdict).toEqual({ winnerId: "u1", isTie: false, points: 14 });
  });

  it("empate de puntos: no hay ganador y lo dice", () => {
    const verdict = blockVerdictOf(build({ u1: [[3, 2]], u2: [[4, 1]] }));
    expect(verdict).toEqual({ winnerId: undefined, isTie: true, points: 0 });
  });

  it("quien abandonó no compite por el menor conteo", () => {
    const match = build({ u1: [[6, 6]], u2: [[0, 1]] });
    const abandoned = match.players.find((player) => player.playerId === "u2");
    if (abandoned) abandoned.hasAbandoned = true;
    const verdict = blockVerdictOf(match);
    expect(verdict.winnerId).toBe("u1");
  });
});
