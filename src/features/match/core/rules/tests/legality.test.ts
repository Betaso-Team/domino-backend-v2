import { describe, expect, it } from "vitest";
import {
  canAbandon,
  canDrawTile,
  canPass,
  canPlayTile,
  canProposeBet,
  canRespondBet,
  canRevealTiles,
  hasPlayable,
  playersWithoutTilesSeen,
} from "../legality";
import { type ViewSetup, rulesConfig, viewOf } from "./fixture";

// Se asserta el CÓDIGO y no solo que sea ilegal: el motivo es lo único que el cliente puede
// pintar, así que un test que solo mire `legal: false` dejaría pasar un cambio de motivo — que es
// exactamente el cambio que rompe el botón.
const codeOf = (ruling: { legal: boolean } & { code?: string }) =>
  ruling.legal ? "LEGAL" : ruling.code;

const base: ViewSetup = {
  hands: {
    u1: [
      [6, 1],
      [3, 2],
    ],
    u2: [[5, 5]],
  },
  board: [[6, 4, "RIGHT"]],
  turn: "u1",
};

describe("canPlayTile", () => {
  it("es legal con la ficha en mano y el lado que engancha", () => {
    expect(canPlayTile("u1", { left: 6, right: 1 }, "LEFT", viewOf(base))).toEqual({ legal: true });
  });

  it("acepta la ficha dada vuelta: el orden de los números no es parte de la identidad", () => {
    expect(canPlayTile("u1", { left: 1, right: 6 }, "LEFT", viewOf(base)).legal).toBe(true);
  });

  it("rechaza fuera de turno", () => {
    expect(codeOf(canPlayTile("u2", { left: 5, right: 5 }, "LEFT", viewOf(base)))).toBe(
      "NOT_YOUR_TURN",
    );
  });

  it("rechaza una ficha que no está en la mano", () => {
    expect(codeOf(canPlayTile("u1", { left: 0, right: 0 }, "LEFT", viewOf(base)))).toBe(
      "TILE_NOT_IN_HAND",
    );
  });

  it("rechaza el lado que no engancha", () => {
    expect(codeOf(canPlayTile("u1", { left: 6, right: 1 }, "RIGHT", viewOf(base)))).toBe(
      "SIDE_NOT_PLAYABLE",
    );
  });

  // EL ORDEN DE LAS GUARDAS ES LA API, y estos dos tests son lo que lo fija. Al revés, al que
  // ya perdió el turno le diríamos que su ficha no entra — y con la mesa cerrada le diríamos
  // que no es su turno, cuando lo que pasó es que la partida terminó.
  it("contesta MATCH_NOT_IN_PROGRESS antes que cualquier cosa de la ficha", () => {
    const view = viewOf({ ...base, matchPhase: "FINISHED" });
    expect(codeOf(canPlayTile("u1", { left: 0, right: 0 }, "RIGHT", view))).toBe(
      "MATCH_NOT_IN_PROGRESS",
    );
  });

  it("contesta NO_ROUND_IN_PROGRESS antes de mirar el turno de una ronda que no existe", () => {
    const view = viewOf({ ...base, noRound: true });
    expect(codeOf(canPlayTile("u2", { left: 5, right: 5 }, "LEFT", view))).toBe(
      "NO_ROUND_IN_PROGRESS",
    );
  });

  it("rechaza al que abandonó, aunque sea su turno", () => {
    const view = viewOf({ ...base, abandoned: ["u1"] });
    expect(codeOf(canPlayTile("u1", { left: 6, right: 1 }, "LEFT", view))).toBe("NOT_PLAYING");
  });

  // Congelar la ronda no le toca el turno (`currentTurn` queda intacto), así que sin mirar la
  // FASE el que estaba jugando podría seguir jugando con la mesa congelada.
  it("rechaza jugar con la ronda congelada negociando la apuesta", () => {
    const view = viewOf({ ...base, roundPhase: "NEGOTIATING_BET" });
    expect(codeOf(canPlayTile("u1", { left: 6, right: 1 }, "LEFT", view))).toBe("NOT_PLAYING");
  });
});

describe("canDrawTile y canPass", () => {
  // Sin ficha que enganche: el tablero cierra en 0 y 4, y la mano no los tiene.
  const stuck: ViewSetup = {
    hands: { u1: [[3, 2]], u2: [[5, 5]] },
    board: [[0, 4, "RIGHT"]],
    turn: "u1",
  };

  it("robar es legal solo sin jugada y con pozo", () => {
    expect(canDrawTile("u1", viewOf({ ...stuck, boneyardCount: 3 })).legal).toBe(true);
  });

  it("con una ficha que engancha, robar es elegir no jugar", () => {
    expect(codeOf(canDrawTile("u1", viewOf({ ...base, boneyardCount: 3 })))).toBe(
      "MUST_PLAY_INSTEAD_OF_DRAWING",
    );
  });

  it("sin pozo no se roba", () => {
    expect(codeOf(canDrawTile("u1", viewOf({ ...stuck, boneyardCount: 0 })))).toBe(
      "BONEYARD_EMPTY",
    );
  });

  it("pasar es el último recurso: con pozo hay que robar", () => {
    expect(codeOf(canPass("u1", viewOf({ ...stuck, boneyardCount: 1 })))).toBe(
      "MUST_DRAW_INSTEAD_OF_PASSING",
    );
  });

  it("pasar es legal sin jugada y sin pozo", () => {
    expect(canPass("u1", viewOf({ ...stuck, boneyardCount: 0 })).legal).toBe(true);
  });

  // Los dos motivos son distintos a propósito: "jugá" y "robá" son dos instrucciones
  // diferentes, y es lo que le deja al cliente pintar el botón correcto.
  it("distingue el motivo de no poder pasar del de no poder robar", () => {
    const view = viewOf({ ...stuck, boneyardCount: 1 });
    expect(codeOf(canPass("u1", view))).not.toBe(codeOf(canDrawTile("u1", view)));
  });
});

describe("canRevealTiles", () => {
  const dealing: ViewSetup = { ...base, roundPhase: "DEALING" };

  // NO pasa por el turno: la ventana de reparto controla a TODOS a la vez.
  it("es legal para cualquiera durante el reparto, con turno o sin él", () => {
    expect(canRevealTiles("u1", viewOf(dealing)).legal).toBe(true);
    expect(canRevealTiles("u2", viewOf(dealing)).legal).toBe(true);
  });

  it("rechaza fuera de la ventana", () => {
    expect(codeOf(canRevealTiles("u1", viewOf(base)))).toBe("NOT_DEALING");
  });

  it("rechaza levantarlas dos veces", () => {
    expect(codeOf(canRevealTiles("u1", viewOf({ ...dealing, seenTiles: ["u1"] })))).toBe(
      "TILES_ALREADY_SEEN",
    );
  });

  it("los que faltan son los que no las levantaron y siguen en la ronda", () => {
    const view = viewOf({ ...dealing, seenTiles: ["u1"] });
    expect(playersWithoutTilesSeen(view)).toEqual(["u2"]);
  });

  it("el que abandonó no cuenta como ausente: no hay a quién esperar", () => {
    const view = viewOf({ ...dealing, abandoned: ["u2"] });
    expect(playersWithoutTilesSeen(view)).toEqual(["u1"]);
  });
});

describe("canAbandon", () => {
  it("alcanza con estar jugando", () => {
    expect(canAbandon("u1", viewOf(base)).legal).toBe(true);
    expect(canAbandon("u1", viewOf({ ...base, roundPhase: "PRESENTING_ROUND" })).legal).toBe(true);
  });

  it("no se abandona una partida terminada", () => {
    expect(codeOf(canAbandon("u1", viewOf({ ...base, matchPhase: "FINISHED" })))).toBe(
      "MATCH_NOT_IN_PROGRESS",
    );
  });
});

describe("canProposeBet", () => {
  const config = rulesConfig();

  it("es legal con el tablero recién abierto, y no mira el turno", () => {
    expect(canProposeBet("u1", 1, viewOf(base), config).legal).toBe(true);
    expect(canProposeBet("u2", 1, viewOf(base), config).legal).toBe(true);
  });

  it("la ventana aguanta una ficha y se cierra con dos", () => {
    const twoTiles = viewOf({
      ...base,
      board: [
        [6, 4, "RIGHT"],
        [4, 2, "RIGHT"],
      ],
    });
    expect(codeOf(canProposeBet("u1", 1, twoTiles, config))).toBe("BET_WINDOW_CLOSED");
  });

  it("una mesa gratis no aumenta, aunque traiga catálogo", () => {
    expect(codeOf(canProposeBet("u1", 1, viewOf(base), rulesConfig({ isFreeRoom: true })))).toBe(
      "BETTING_DISABLED",
    );
  });

  it("sin catálogo falla CERRADO", () => {
    expect(codeOf(canProposeBet("u1", 1, viewOf(base), rulesConfig({ betLevels: [] })))).toBe(
      "BETTING_DISABLED",
    );
  });

  it("uno aceptado es el tope de la partida", () => {
    const view = viewOf({ ...base, acceptedBetLevel: 2 });
    expect(codeOf(canProposeBet("u1", 1, view, config))).toBe("BET_ALREADY_ACCEPTED");
  });

  it("una oferta viva bloquea la segunda", () => {
    const view = viewOf({
      ...base,
      betOffer: { proposerId: "u2", level: 1, extra: 1, additionalEntryFee: 10 },
    });
    expect(codeOf(canProposeBet("u1", 1, view, config))).toBe("BET_ALREADY_PENDING");
  });

  it("el nivel tiene que estar en el catálogo de ESTA mesa", () => {
    expect(codeOf(canProposeBet("u1", 99, viewOf(base), config))).toBe("UNKNOWN_BET_LEVEL");
  });

  // El nivel se juzga ÚLTIMO: con la ventana cerrada, decirle "ese nivel no existe" lo manda a
  // probar otro nivel cuando lo que pasó es que se le fue el momento.
  it("el motivo de la ventana gana al del nivel desconocido", () => {
    const view = viewOf({ ...base, roundPhase: "DEALING" });
    expect(codeOf(canProposeBet("u1", 99, view, config))).toBe("BET_WINDOW_CLOSED");
  });
});

describe("canRespondBet", () => {
  const offered: ViewSetup = {
    ...base,
    roundPhase: "NEGOTIATING_BET",
    betOffer: { proposerId: "u1", level: 1, extra: 1, additionalEntryFee: 10 },
  };

  it("contesta el que no propuso, le toque o no", () => {
    expect(canRespondBet("u2", viewOf(offered)).legal).toBe(true);
  });

  it("el proponente no se acepta a sí mismo", () => {
    expect(codeOf(canRespondBet("u1", viewOf(offered)))).toBe("NOT_YOUR_BET");
  });

  it("sin oferta no hay nada que contestar", () => {
    expect(codeOf(canRespondBet("u2", viewOf(base)))).toBe("NO_BET_PENDING");
  });
});

describe("hasPlayable", () => {
  it("contesta por la mano, no por el asiento", () => {
    expect(hasPlayable("u1", viewOf(base))).toBe(true);
    expect(hasPlayable("u2", viewOf(base))).toBe(false);
  });

  // LA MITAD CLIENTE DE LA FRONTERA: sin ver la mano no se afirma que alguien puede jugar.
  // Errar hacia "no puede" apaga un botón que no era suyo; al revés, encendería uno que sí.
  it("con la mano ajena oculta contesta false en vez de adivinar", () => {
    const view = viewOf({ ...base, visibleHandsOf: ["u2"] });
    expect(hasPlayable("u1", view)).toBe(false);
  });
});
