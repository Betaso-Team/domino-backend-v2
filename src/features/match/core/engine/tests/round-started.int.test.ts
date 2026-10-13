import { describe, expect, it } from "vitest";
import { engineWithHands } from "./build-engine";

// CADA REPARTO SE ANUNCIA (truco `b5bb427`). El árbol muestra las manos pero nunca dice CUÁNDO se
// repartieron, y nadie pide que una mano empiece: sigue de arrancar la partida o de que la anterior
// cierre. Es la marca de la que el historial saca la mano de cada entrada y detrás de la cual
// fotografía el reparto.
describe("ROUND_STARTED", () => {
  it("arrancar la partida anuncia la primera mano", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });

    expect(e.start()).toEqual([{ type: "ROUND_STARTED", roundNumber: 1 }]);
  });

  it("un segundo aviso de arranque no reparte ni anuncia nada", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.start();

    expect(e.start()).toEqual([]);
  });

  // El reparto pasa al ENTRAR a la ventana, no al salir: las fichas ya están en las manos.
  it("con ventana de reparto, se anuncia al repartir y no al levantar las fichas", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] }, [], { isDealWindowEnabled: true });

    expect(e.start()).toEqual([{ type: "ROUND_STARTED", roundNumber: 1 }]);
    expect(e.revealTiles("u1")).not.toContainEqual(
      expect.objectContaining({ type: "ROUND_STARTED" }),
    );
  });

  it("la mano siguiente se anuncia al vencer la pausa de la anterior, después del vencimiento", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");

    expect(e.fireTimeout()).toEqual([
      { type: "DEADLINE_EXPIRED", kind: "PRESENTING_ROUND" },
      { type: "ROUND_STARTED", roundNumber: 2 },
    ]);
    expect(e.round().roundNumber).toBe(2);
  });
});
