import { describe, expect, it } from "vitest";
import { type GameAction, legalActionsFor } from "../actions.js";
import { type ViewSetup, rulesConfig, viewOf } from "./fixture.js";

const base: ViewSetup = {
  hands: {
    u1: [
      [6, 1],
      [3, 2],
      [0, 0],
    ],
    u2: [[5, 5]],
  },
  board: [[6, 4, "RIGHT"]],
  turn: "u1",
};

const verbs = (setup: ViewSetup, playerId = "u1"): GameAction[] =>
  legalActionsFor(playerId, viewOf(setup), rulesConfig()).map(({ action }) => action);

const actionOf = (setup: ViewSetup, action: GameAction, playerId = "u1") =>
  legalActionsFor(playerId, viewOf(setup), rulesConfig()).find((entry) => entry.action === action);

describe("legalActionsFor", () => {
  it("al que le toca le ofrece jugar, abandonar y proponer", () => {
    expect(verbs(base)).toEqual(["PLAY_TILE", "ABANDON", "PROPOSE_BET_MULTIPLIER"]);
  });

  // Al que NO le toca no le ofrece jugar, y sí proponer: el aumento no mira el turno (v1).
  it("al que no le toca le quedan abandonar y proponer", () => {
    expect(verbs(base, "u2")).toEqual(["ABANDON", "PROPOSE_BET_MULTIPLIER"]);
  });

  it("no ofrece nada a quien no está en la partida", () => {
    expect(verbs({ ...base, matchPhase: "FINISHED" })).toEqual([]);
  });

  // LAS FICHAS SON LOS BOTONES: el verbo sin las colocaciones no diría cuál ni de qué lado, y
  // derivarlo afuera obligaría al cliente a reimplementar `playableSides`.
  it("las colocaciones dicen qué ficha entra y por dónde", () => {
    // El tablero es [6|4]: cierra en 6 y en 4. La [6|1] engancha por el 6 (izquierda) y la
    // [0|0] no engancha en ninguna punta, así que no está en la lista.
    expect(actionOf(base, "PLAY_TILE")?.placements).toEqual([
      { tile: { left: 6, right: 1 }, sides: ["LEFT"] },
    ]);
  });

  it("una ficha que entra por las dos puntas las lista a las dos", () => {
    const setup: ViewSetup = { hands: { u1: [[6, 4]], u2: [[5, 5]] }, board: [[6, 4, "RIGHT"]] };
    expect(actionOf(setup, "PLAY_TILE")?.placements).toEqual([
      { tile: { left: 6, right: 4 }, sides: ["LEFT", "RIGHT"] },
    ]);
  });

  it("sin jugada legal no ofrece el verbo, y ofrece el que corresponde", () => {
    const stuck: ViewSetup = {
      hands: { u1: [[3, 2]], u2: [[5, 5]] },
      board: [[0, 4, "RIGHT"]],
      turn: "u1",
    };
    expect(verbs({ ...stuck, boneyardCount: 2 })).toEqual([
      "DRAW_TILE",
      "ABANDON",
      "PROPOSE_BET_MULTIPLIER",
    ]);
    expect(verbs({ ...stuck, boneyardCount: 0 })).toEqual([
      "PASS",
      "ABANDON",
      "PROPOSE_BET_MULTIPLIER",
    ]);
  });

  it("en la ventana de reparto solo se levantan las fichas", () => {
    // Proponer no entra: la ventana del aumento es de la fase de juego.
    expect(verbs({ ...base, roundPhase: "DEALING" })).toEqual(["REVEAL_TILES", "ABANDON"]);
  });

  it("los niveles ofrecibles viajan con el verbo", () => {
    expect(actionOf(base, "PROPOSE_BET_MULTIPLIER")?.levels).toEqual([1, 2]);
  });

  it("una mesa que no aumenta no ofrece el verbo", () => {
    const actions = legalActionsFor("u1", viewOf(base), rulesConfig({ isFreeRoom: true })).map(
      ({ action }) => action,
    );
    expect(actions).not.toContain("PROPOSE_BET_MULTIPLIER");
  });

  it("negociando, al que le toca contestar le ofrece contestar y no jugar", () => {
    const offered: ViewSetup = {
      ...base,
      roundPhase: "NEGOTIATING_BET",
      betOffer: { proposerId: "u1", level: 1, extra: 1, additionalEntryFee: 10 },
    };
    expect(verbs(offered, "u2")).toEqual(["ABANDON", "RESPOND_BET_MULTIPLIER"]);
    expect(verbs(offered, "u1")).toEqual(["ABANDON"]);
  });

  // La mitad cliente: con la mano oculta no se enciende un botón de jugar que no es suyo.
  it("con la mano ajena oculta no ofrece colocaciones", () => {
    expect(verbs({ ...base, visibleHandsOf: ["u2"] })).not.toContain("PLAY_TILE");
  });
});
