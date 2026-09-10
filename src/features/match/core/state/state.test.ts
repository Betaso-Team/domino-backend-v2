import { Encoder, StateView } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import { Hand, MatchState, PlayerState, Tile } from "./index.js";

describe("árbol de estado", () => {
  it("una ficha lleva sus dos números", () => {
    const tile = new Tile();
    tile.left = 6;
    tile.right = 4;
    expect(tile.toJSON()).toEqual({ left: 6, right: 4 });
  });

  it("la mano expone el conteo como campo público", () => {
    const hand = new Hand();
    const tile = new Tile();
    tile.left = 3;
    tile.right = 3;
    hand.tiles.push(tile);
    hand.tileCount = hand.tiles.length;
    expect(hand.tileCount).toBe(1);
  });

  it("MatchState arranca vacío y en NOT_STARTED", () => {
    const match = new MatchState();
    expect(match.phase).toBe("NOT_STARTED");
    expect(match.players.length).toBe(0);
    expect(match.currentRound).toBeUndefined();
    expect(match.activeDeadline).toBe(0);
  });

  it("las fichas de la mano son un campo de VISTA: una StateView vacía no las tiene", () => {
    const hand = new Hand();
    // `StateView.add()`/`.has()` solo empiezan a marcar/leer bits de visibilidad una vez
    // que el ChangeTree del objetivo tiene un Root asignado — exactamente lo que un Room
    // de Colyseus hace por dentro al asignar `this.state = ...`. Un `Hand` suelto, sin
    // Encoder, nunca gana ese Root, así que `view.add()` sería un no-op silencioso y el
    // test no probaría nada (verificado contra el código fuente instalado). El único rol
    // de este `Encoder` acá es darle Root al árbol; no se usa para codificar nada.
    new Encoder(hand);
    const view = new StateView();
    // El contrato que importa: `tiles` está marcado como vista, así que su
    // pertenencia se decide por StateView y no por estar en el árbol.
    expect(view.has(hand.tiles)).toBe(false);
    view.add(hand.tiles);
    expect(view.has(hand.tiles)).toBe(true);
  });

  it("ningún nodo pasa el cap de 63 campos de 0.18", () => {
    for (const node of [new Tile(), new Hand(), new PlayerState(), new MatchState()]) {
      expect(Object.keys(node.toJSON()).length).toBeLessThan(63);
    }
  });
});
