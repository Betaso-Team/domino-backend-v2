import { Encoder, StateView } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import { Hand, MatchState, PlayerState, RoundState, Tile } from "./index";

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
    expect(match.scoreboard).toBeUndefined();
    expect(match.activeDeadline).toBe(0);
  });

  it("RoundState: la rama nula del pozo es distinguible de un tablero que sí existe", () => {
    // La asimetría ES el punto, así que el test la fija en las dos direcciones:
    // `board` existe siempre (toda ronda tiene tablero, aunque esté vacío), pero
    // `boneyard` y `currentTurn` llevan `.optional()` y arrancan `undefined` — es la
    // génesis (Tarea 6) quien decide instanciar `boneyard` o no, según el modo tenga
    // pozo. Si alguien le saca el `.optional()` a `boneyard` en round.ts, este test es
    // el que se pone rojo: sin él, un 4P (sin pozo) sería indistinguible de un pozo ya
    // agotado, que es justo el bug que la rama nula existe para prevenir.
    const round = new RoundState();
    expect(round.board).toBeDefined();
    expect(round.boneyard).toBeUndefined();
    expect(round.currentTurn).toBeUndefined();
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

  // No hay test de "ningún nodo pasa el cap de 63 campos": @colyseus/schema lo aplica
  // en tiempo de DEFINICIÓN (`Metadata.defineField` lanza al construir el schema), no
  // en runtime, así que una violación real revienta al importar el módulo, antes de que
  // corra un solo `it()` de este archivo — no hay nada útil que este describe pudiera
  // asertar. Detalle completo en el comentario de cabecera de `state/index.ts`.
});

// LA LISTA CERRADA DE LO QUE UN ASIENTO SINCRONIZA A TODA LA MESA (`docs/convenciones/audiencias.md` del
// orquestador). El estado es de todos los que la juegan, y en una mesa cruzada son de dos proveedores:
// un campo nuevo en `PlayerState` que viaje sin `view` lo ve el jugador del otro proveedor, así que
// agregarlo pone esto en rojo y obliga a decidirlo. Lo privado de un asiento —`userId`, proveedor,
// moneda, precio— no está: va en el mensaje `config` de ese asiento solo, o no sale.
describe("PlayerState: lo que viaja a toda la mesa", () => {
  type Field = { readonly name: string; readonly tag?: number };
  const fieldsOf = (schemaClass: object): Field[] => {
    const metadata = (schemaClass as Record<symbol, Record<string, Field>>)[Symbol.metadata] ?? {};
    return Object.keys(metadata)
      .filter((key) => /^\d+$/.test(key))
      .map((key) => metadata[key] as Field);
  };

  it("sincroniza sin vista exactamente estos campos, en este orden", () => {
    const synced = fieldsOf(PlayerState);
    expect(synced.filter((field) => field.tag === undefined).map((field) => field.name)).toEqual([
      "playerId",
      "displayName",
      "username",
      "profilePicture",
      "teamId",
      "seatIndex",
      "connected",
      "hasAbandoned",
      "hasSeenTiles",
      "extraTimeRemainingMs",
      "hand",
      "isBot",
    ]);
    // Y ninguno con vista: lo que es de un solo asiento (las fichas) vive en `Hand.tiles`.
    expect(synced.filter((field) => field.tag !== undefined)).toEqual([]);
  });

  it("el userId queda del lado del servidor: ni índice ni `toJSON()`", () => {
    const player = new PlayerState();
    player.userId = "u-privado";
    expect(fieldsOf(PlayerState).map((field) => field.name)).not.toContain("userId");
    expect(JSON.stringify(player.toJSON())).not.toContain("u-privado");
  });
});
