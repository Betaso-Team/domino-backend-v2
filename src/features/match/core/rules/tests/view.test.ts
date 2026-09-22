import { describe, expect, it } from "vitest";
import { roundState } from "../../engine/round/tests/round-fixture";
import { RematchState } from "../../state/rematch";
import { SchemaMatchView } from "../../state/view";
import { canPlayTile, hasPlayable } from "../legality";
import type { PublicMatchView } from "../view";

// LA FRONTERA, MEDIDA DE LOS DOS LADOS: que el ÁRBOL satisface la vista sin copiarse, y que la
// PUERTA de lo privado es la única forma de llegar a una mano.
describe("SchemaMatchView", () => {
  const setup = {
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

  it("el MatchState satisface la vista pública SIN adaptador", () => {
    // La asignación ES la aserción: si el árbol dejara de satisfacer la vista, esto no compila.
    // El `expect` de abajo existe para que el test falle en vez de quedar vacío.
    const match = roundState(setup);
    const view: PublicMatchView = match;
    expect(view.players.length).toBe(2);
    expect(view.currentRound?.board.tiles.length).toBe(1);
  });

  it("los getters devuelven el nodo VIVO, no una copia", () => {
    const match = roundState(setup);
    const view = new SchemaMatchView(match);
    expect(view.currentRound?.board.tiles.length).toBe(1);
    match.currentRound = undefined;
    // Con un spread del árbol esto seguiría contestando la ronda de antes.
    expect(view.currentRound).toBeUndefined();
  });

  // ⚠ EL GUARDARRAÍL DE LOS CAMPOS OPCIONALES, y nació de un defecto real: `rematch` es una
  // rama nula, así que en `PublicMatchView` es opcional — y un getter que falta en esta clase
  // COMPILA IGUAL, porque omitir un opcional sigue satisfaciendo la interfaz.
  //
  // Faltó, y el resultado fue que toda regla de revancha leía `undefined` y contestaba
  // `NO_REMATCH_PENDING` con la negociación abierta del otro lado del árbol. No lo vio el test
  // de reglas —arma la vista como objeto plano, sin pasar por acá— ni el del motor, que llama
  // al conductor sin juez. Lo encontró el E2E, que es el último lugar donde uno quiere
  // enterarse.
  //
  // Se mide comparando las CLAVES del árbol contra las de la vista en vez de nombrar `rematch`:
  // así el próximo campo opcional que alguien agregue al schema y olvide acá se pone rojo solo.
  it("expone TODOS los campos del árbol, también los opcionales", () => {
    const match = roundState(setup);
    // LAS RAMAS NULAS SE INSTANCIAN, y sin esto el test es DECORATIVO: `toJSON()` omite la
    // clave de un `.optional()` ausente, así que la comparación no tendría qué echar en falta
    // y pasaría verde con el getter borrado. Medido.
    match.rematch = new RematchState();
    const view = new SchemaMatchView(match);
    // `privateOf` es de la vista y no del árbol: es la puerta, no un campo.
    const exposed = new Set([
      ...Object.keys(view),
      ...Object.keys(Object.getPrototypeOf(view) as object),
      ...Object.getOwnPropertyNames(SchemaMatchView.prototype),
    ]);

    const missing = Object.keys(match.toJSON()).filter((field) => !exposed.has(field));

    expect(missing).toEqual([]);
  });

  it("privateOf contesta por cada asiento en el servidor", () => {
    const view = new SchemaMatchView(roundState(setup));
    expect(view.privateOf("u1")?.tiles.length).toBe(2);
    expect(view.privateOf("u2")?.tiles.length).toBe(1);
  });

  it("privateOf contesta undefined por un id sin asiento", () => {
    const view = new SchemaMatchView(roundState(setup));
    expect(view.privateOf("nadie")).toBeUndefined();
  });

  it("las reglas del motor y las de un objeto plano dan el MISMO veredicto", () => {
    // Es la afirmación entera del módulo: la regla no sabe con cuál de las dos vistas la
    // llamaron. Acá corre contra el árbol de Colyseus.
    const view = new SchemaMatchView(roundState(setup));
    expect(canPlayTile("u1", { left: 6, right: 1 }, "LEFT", view).legal).toBe(true);
    expect(hasPlayable("u2", view)).toBe(false);
  });

  // LO QUE NO COMPILA es la mitad de esta frontera, y ningún `expect` la puede medir: la vista
  // NO declara `players[n].hand.tiles` ni `boneyard.tiles` —los dos campos `.view()` del
  // schema—, así que una regla que los pida no tipa. El nodo del servidor SÍ los tiene; la
  // garantía es que el tipo con el que las reglas están escritas no los nombra, y por eso la
  // única ruta a una mano es `privateOf`. No hay test en runtime de eso: lo comprueba el gate
  // `typecheck`, que es donde tiene que fallar.
});
