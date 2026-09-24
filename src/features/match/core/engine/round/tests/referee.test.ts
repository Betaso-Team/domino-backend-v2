import { describe, expect, it } from "vitest";
import { RuleViolationError } from "../../errors";
import { RoundReferee } from "../referee";
import { roundState } from "./round-fixture";

const refereeFor = (setup: Parameters<typeof roundState>[0]) => new RoundReferee(roundState(setup));

describe("RoundReferee.assertCanPlay", () => {
  const base = {
    hands: {
      u1: [
        [6, 1],
        [3, 2],
      ] as [number, number][],
      u2: [[5, 5]] as [number, number][],
    },
    board: [[6, 4, "RIGHT"]] as [number, number, "RIGHT"][],
    turn: "u1",
  };

  it("acepta una jugada legal", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 6, right: 1 }, "LEFT")).not.toThrow();
  });

  it("rechaza jugar fuera de turno", () => {
    expect(() => refereeFor(base).assertCanPlay("u2", { left: 5, right: 5 }, "LEFT")).toThrow(
      new RuleViolationError("NOT_YOUR_TURN"),
    );
  });

  it("rechaza una ficha que no está en la mano", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 0, right: 0 }, "LEFT")).toThrow(
      new RuleViolationError("TILE_NOT_IN_HAND"),
    );
  });

  it("rechaza colgar de un lado donde no engancha", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 6, right: 1 }, "RIGHT")).toThrow(
      new RuleViolationError("SIDE_NOT_PLAYABLE"),
    );
  });

  it("rechaza cualquier jugada si la ronda no está en PLAYING", () => {
    expect(() =>
      refereeFor({ ...base, phase: "PRESENTING_ROUND" }).assertCanPlay(
        "u1",
        { left: 6, right: 1 },
        "LEFT",
      ),
    ).toThrow(new RuleViolationError("NOT_PLAYING"));
  });

  it("reconoce la ficha aunque venga escrita al revés", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 1, right: 6 }, "LEFT")).not.toThrow();
  });
});

describe("RoundReferee — robar y pasar", () => {
  const stuck = {
    hands: { u1: [[3, 2]] as [number, number][], u2: [[5, 5]] as [number, number][] },
    board: [[6, 4, "RIGHT"]] as [number, number, "RIGHT"][],
    turn: "u1",
  };

  it("se puede robar si no hay jugada y queda pozo", () => {
    expect(() => refereeFor({ ...stuck, boneyard: [[0, 0]] }).assertCanDraw("u1")).not.toThrow();
  });

  it("NO se puede robar pudiendo jugar: robar es el recurso de quien no puede", () => {
    const canPlay = {
      ...stuck,
      hands: { u1: [[6, 1]] as [number, number][], u2: [[5, 5]] as [number, number][] },
      boneyard: [[0, 0]] as [number, number][],
    };
    expect(() => refereeFor(canPlay).assertCanDraw("u1")).toThrow(
      new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING"),
    );
  });

  it("NO se puede robar de un pozo vacío", () => {
    expect(() => refereeFor(stuck).assertCanDraw("u1")).toThrow(
      new RuleViolationError("BONEYARD_EMPTY"),
    );
  });

  it("se puede pasar solo con el pozo vacío y sin jugada", () => {
    expect(() => refereeFor(stuck).assertCanPass("u1")).not.toThrow();
  });

  it("NO se puede pasar habiendo pozo: primero se roba", () => {
    expect(() => refereeFor({ ...stuck, boneyard: [[0, 0]] }).assertCanPass("u1")).toThrow(
      new RuleViolationError("MUST_DRAW_INSTEAD_OF_PASSING"),
    );
  });

  it("NO se puede pasar pudiendo jugar", () => {
    const canPlay = {
      ...stuck,
      hands: { u1: [[6, 1]] as [number, number][], u2: [[5, 5]] as [number, number][] },
    };
    expect(() => refereeFor(canPlay).assertCanPass("u1")).toThrow(
      new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING"),
    );
  });
});
