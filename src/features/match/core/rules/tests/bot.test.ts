import { describe, expect, it } from "vitest";
import { botMoveOf } from "../bot";
import { type ViewSetup, rulesConfig, viewOf } from "./fixture";

// LA POLÍTICA DEL BOT. Lo que se mide es la ELECCIÓN, no la legalidad: de eso ya se ocupa
// `availableActionsFor`, y que el bot pase por ahí es justamente lo que se fija abajo.

const moveOf = (setup: ViewSetup, playerId = "u1") =>
  botMoveOf(playerId, viewOf(setup), rulesConfig());

describe("la ficha que elige la máquina", () => {
  // LA REGLA DE v1: la jugable de MÁS pips. Acá el 6|6 no engancha —el tablero cierra en 4 y en
  // 1— así que la elegida es el 4|3, que suma 7 contra los 5 del 1|0.
  it("juega la ficha jugable de mayor valor", () => {
    const move = moveOf({
      hands: {
        u1: [
          [6, 6],
          [4, 3],
          [1, 0],
        ],
        u2: [[5, 5]],
      },
      board: [[4, 1, "RIGHT"]],
      turn: "u1",
    });

    expect(move).toEqual({ type: "PLAY_TILE", tile: { left: 4, right: 3 }, side: "LEFT" });
  });

  // ⚠ LA FICHA MÁS GORDA DE LA MANO NO ES LA ELEGIDA SI NO ENGANCHA, y es el caso que separa
  // «elijo entre lo legal» de «elijo y después veo»: con el 6|6 en la mano, un bot que ordenara
  // por valor antes de mirar el tablero mandaría una jugada que el comando rechaza — y el asiento
  // quedaría mudo hasta que venza el reloj, que es perder por otro camino.
  it("no elige la más gorda si no engancha", () => {
    const move = moveOf({
      hands: {
        u1: [
          [6, 6],
          [2, 1],
        ],
        u2: [[5, 5]],
      },
      board: [[2, 3, "RIGHT"]],
      turn: "u1",
    });

    expect(move).toMatchObject({ type: "PLAY_TILE", tile: { left: 2, right: 1 } });
  });

  // EL TABLERO VACÍO NO ES UN CASO APARTE aunque en v1 lo sea: con la mesa vacía toda la mano es
  // jugable, así que «la jugable de mayor valor» ya es «la más alta de la mano».
  it("con el tablero vacío juega la más alta de la mano", () => {
    const move = moveOf({
      hands: {
        u1: [
          [1, 0],
          [6, 5],
          [3, 3],
        ],
        u2: [[5, 5]],
      },
      turn: "u1",
    });

    expect(move).toMatchObject({ type: "PLAY_TILE", tile: { left: 6, right: 5 } });
  });

  // Los dos desempates existen por el REPLAY y no por el juego: con azar, dos corridas de la
  // misma partida grabada no darían la misma jugada.
  it("ante el mismo valor se queda con la primera de la mano", () => {
    const move = moveOf({
      hands: {
        u1: [
          [4, 2],
          [5, 1],
        ],
        u2: [[5, 5]],
      },
      board: [[4, 1, "RIGHT"]],
      turn: "u1",
    });

    expect(move).toMatchObject({ tile: { left: 4, right: 2 } });
  });

  it("si engancha por los dos lados elige el que la regla declara primero", () => {
    const move = moveOf({
      hands: { u1: [[3, 3]], u2: [[5, 5]] },
      board: [[3, 3, "RIGHT"]],
      turn: "u1",
    });

    expect(move).toMatchObject({ side: "LEFT" });
  });
});

describe("cuando no hay ficha que poner", () => {
  // EL ORDEN PONER → CARGAR → PASAR no lo elige el bot: lo imponen las reglas, que hacen ilegal
  // robar con una ficha en la mano que engancha, y pasar con el pozo cargado.
  it("carga del pozo si no engancha ninguna y queda de dónde", () => {
    const move = moveOf({
      hands: { u1: [[5, 5]], u2: [[2, 1]] },
      board: [[4, 3, "RIGHT"]],
      boneyardCount: 4,
      turn: "u1",
    });

    expect(move).toEqual({ type: "DRAW_TILE" });
  });

  it("pasa si no engancha ninguna y el pozo está vacío", () => {
    const move = moveOf({
      hands: { u1: [[5, 5]], u2: [[2, 1]] },
      board: [[4, 3, "RIGHT"]],
      boneyardCount: 0,
      turn: "u1",
    });

    expect(move).toEqual({ type: "PASS" });
  });

  // NO INVENTA UN TURNO QUE NO ES SUYO. El `undefined` es lo que hace que el llamador —la red,
  // que reacciona a cada patch— pueda preguntar siempre sin tener que saber de quién es el turno.
  it("no devuelve nada si no le toca", () => {
    const move = moveOf(
      {
        hands: { u1: [[5, 5]], u2: [[4, 1]] },
        board: [[4, 3, "RIGHT"]],
        turn: "u1",
      },
      "u2",
    );

    expect(move).toBeUndefined();
  });

  // Ni en una mesa que no está jugando. La ventana de reparto es el caso real: ahí el bot todavía
  // no existe —quien no levanta sus fichas se retira y la mesa se cancela— y preguntar acá no
  // puede devolver una jugada.
  it("no devuelve nada con la ronda congelada por un aumento", () => {
    const move = moveOf({
      hands: { u1: [[4, 1]], u2: [[5, 5]] },
      board: [[4, 3, "RIGHT"]],
      turn: "u1",
      roundPhase: "NEGOTIATING_BET",
    });

    expect(move).toBeUndefined();
  });
});
