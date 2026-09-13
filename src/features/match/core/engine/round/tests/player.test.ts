import { describe, expect, it, vi } from "vitest";
import { currentRoundOf, handOf, playerOf } from "../../state-projections.js";
import type { SchemaVisibilityController } from "../../visibility.js";
import { boardEndsOf } from "../board-ends.js";
import { RoundPlayer } from "../player.js";
import { roundState } from "./round-fixture.js";

const visibility: SchemaVisibilityController = {
  makePublic() {},
  hide() {},
};

const playerFor = (playerId: string, match: ReturnType<typeof roundState>) =>
  new RoundPlayer(playerId, match, visibility);

describe("RoundPlayer.revealTiles y hideTiles", () => {
  it("marca la mano vista y revela exactamente sus fichas al dueño", () => {
    const match = roundState({ hands: { u1: [[6, 1]], u2: [[5, 5]] } });
    const makePublic = vi.fn();
    const recordingVisibility = { makePublic, hide: vi.fn() } satisfies SchemaVisibilityController;

    new RoundPlayer("u1", match, recordingVisibility).revealTiles();

    expect(playerOf("u1", match).hasSeenTiles).toBe(true);
    expect(makePublic).toHaveBeenCalledOnce();
    expect(makePublic.mock.calls[0]?.[0]).toBe(handOf("u1", match).tiles);
    expect(makePublic.mock.calls[0]?.[1]).toEqual({
      kind: "PLAYER",
      playerId: "u1",
    });
  });

  it("oculta exactamente las fichas de la mano a todos", () => {
    const match = roundState({ hands: { u1: [[6, 1]], u2: [[5, 5]] } });
    const hide = vi.fn();
    const recordingVisibility = { makePublic: vi.fn(), hide } satisfies SchemaVisibilityController;

    new RoundPlayer("u1", match, recordingVisibility).hideTiles();

    expect(hide).toHaveBeenCalledOnce();
    expect(hide.mock.calls[0]?.[0]).toBe(handOf("u1", match).tiles);
    expect(hide.mock.calls[0]?.[1]).toEqual({ kind: "ALL" });
  });
});

describe("RoundPlayer.playTile", () => {
  it("saca la ficha de la mano, la pone en la mesa y mantiene tileCount", () => {
    const match = roundState({
      hands: {
        u1: [
          [6, 1],
          [3, 2],
        ],
        u2: [[5, 5]],
      },
      board: [[6, 4, "RIGHT"]],
    });
    playerFor("u1", match).playTile({ left: 6, right: 1 }, "LEFT");

    const hand = handOf("u1", match);
    expect(hand.tiles.length).toBe(1);
    expect(hand.tileCount).toBe(1);
    expect(match.currentRound?.board.tiles.length).toBe(2);
  });

  it("guarda quién la jugó y de qué lado", () => {
    const match = roundState({
      hands: { u1: [[6, 1]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    playerFor("u1", match).playTile({ left: 6, right: 1 }, "LEFT");

    const placed = match.currentRound?.board.tiles.at(-1);
    expect(placed?.playedBy).toBe("u1");
    expect(placed?.side).toBe("LEFT");
  });

  it("siempre añade AL FINAL del array, incluso jugando a la izquierda", () => {
    const match = roundState({
      hands: { u1: [[6, 1]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    playerFor("u1", match).playTile({ left: 6, right: 1 }, "LEFT");

    expect(match.currentRound?.board.tiles.at(0)?.tile.toJSON()).toEqual({ left: 6, right: 4 });
    expect(boardEndsOf(currentRoundOf(match).board)).toEqual({ left: 1, right: 4 });
  });

  it("acepta la ficha escrita al revés y guarda la que tenía en la mano", () => {
    const match = roundState({
      hands: { u1: [[6, 1]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    playerFor("u1", match).playTile({ left: 1, right: 6 }, "LEFT");
    expect(match.currentRound?.board.tiles.at(-1)?.tile.toJSON()).toEqual({ left: 6, right: 1 });
  });
});

describe("RoundPlayer.drawTile", () => {
  it("mueve una ficha del pozo a la mano y actualiza los dos contadores", () => {
    const match = roundState({
      hands: { u1: [[3, 2]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
      boneyard: [
        [0, 0],
        [1, 1],
      ],
    });
    playerFor("u1", match).drawTile();

    expect(handOf("u1", match).tiles.length).toBe(2);
    expect(handOf("u1", match).tileCount).toBe(2);
    expect(match.currentRound?.boneyard?.tiles.length).toBe(1);
    expect(match.currentRound?.boneyard?.count).toBe(1);
  });

  it("roba del frente del pozo, así que el orden es determinista", () => {
    const match = roundState({
      hands: { u1: [[3, 2]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
      boneyard: [
        [0, 0],
        [1, 1],
      ],
    });
    playerFor("u1", match).drawTile();
    expect(handOf("u1", match).tiles.at(-1)?.toJSON()).toEqual({ left: 0, right: 0 });
  });
});
