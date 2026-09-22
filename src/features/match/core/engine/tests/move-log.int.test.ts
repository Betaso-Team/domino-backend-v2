import { describe, expect, it } from "vitest";
import type { BetLevel } from "../../config";
import { engineWithHands } from "./build-engine";

// EL REGISTRO DE JUGADAS DE LA MANO. Lo que se mide acá es LO QUE EL ÁRBOL NO GUARDA: si el
// registro repitiera el tablero sería una segunda copia que puede discrepar, así que cada caso de
// abajo es algo que, sin `pastMoves`, se pierde entero.
//
// Y LA MITAD DE LA AFIRMACIÓN ES LO QUE NO ENTRA: son las tres jugadas del dominó y nada más. Los
// tests del final son los que fijan esa frontera, porque es la que se cruza sola —agregar un verbo
// al registro no rompe nada— y la que convertiría este nodo en el cajón de sastre que no es.

const types = (moves: { type: string }[]) => moves.map(({ type }) => type);

// Dos manos que se traban: u1 abre con el doble seis y después nadie engancha. Es el camino que
// pasa por las tres jugadas sin que la ronda se cierre por dominó.
const blockedHands = {
  u1: [
    [6, 6],
    [5, 4],
  ] as [number, number][],
  u2: [
    [3, 2],
    [1, 0],
  ] as [number, number][],
};

describe("registro de jugadas de la mano", () => {
  it("apunta poner, cargar y pasar EN ORDEN, con quién lo hizo", () => {
    const e = engineWithHands(blockedHands, [[3, 3]]);
    e.start();

    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    e.drawTile("u2");
    e.pass("u2");
    e.pass("u1");

    const moves = [...e.round().pastMoves];
    expect(types(moves)).toEqual(["PLAY_TILE", "DRAW_TILE", "PASS", "PASS"]);
    expect(moves.map(({ playerId }) => playerId)).toEqual(["u1", "u2", "u2", "u1"]);
  });

  // ES LO ÚNICO QUE MIDE POR QUÉ EL REGISTRO EXISTE. Cargar y pasar casi no dejan huella propia:
  // `Turn.consecutivePasses` es un contador que se reinicia y `BoneyardState.count` dice cuántas
  // quedan, no quién sacó. Sin el registro, "cargó y después pasó" no está escrito en ningún lado.
  it("distingue la carga del pase, que en el árbol casi no dejan rastro", () => {
    const e = engineWithHands(blockedHands, [[3, 3]]);
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");

    e.drawTile("u2");
    e.pass("u2");

    expect(types([...e.round().pastMoves]).slice(1)).toEqual(["DRAW_TILE", "PASS"]);
  });

  // LA FICHA NO SE DUPLICA: vive en `board.tiles` con su `playedBy` y su `side`. Si esto se
  // rompiera, el registro sería un segundo tablero que puede discrepar del primero.
  //
  // Es además el test que mantiene el nodo en DOS campos: un `toEqual` sobre el JSON entero se
  // pone rojo el día que alguien le cuelgue un tercero.
  it("guarda el verbo y el jugador, y nada más", () => {
    const e = engineWithHands(blockedHands, [[3, 3]]);
    e.start();

    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");

    expect([...e.round().pastMoves][0]?.toJSON()).toEqual({ type: "PLAY_TILE", playerId: "u1" });
    expect([...e.round().board.tiles][0]?.playedBy).toBe("u1");
  });

  // MUERE CON LA RONDA, como el pozo: el panel que lo lee es el de la mano en curso.
  it("arranca vacío en la ronda siguiente", () => {
    const e = engineWithHands(blockedHands, [[3, 3]]);
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    e.drawTile("u2");
    e.pass("u2");
    e.pass("u1");
    expect(e.round().pastMoves.length).toBe(4);

    e.fireTimeout();

    expect(e.round().roundNumber).toBe(2);
    expect(e.round().pastMoves.length).toBe(0);
  });
});

const LEVELS: readonly BetLevel[] = [{ level: 2, extra: 2, additionalPoints: 100 }];

// Manos que no se cierran solas: lo que se mide es que la negociación NO toque el registro.
const betHands = {
  u1: [
    [6, 6],
    [6, 5],
    [4, 3],
  ] as [number, number][],
  u2: [
    [5, 4],
    [3, 2],
    [2, 1],
  ] as [number, number][],
};

describe("registro de jugadas: lo que NO entra", () => {
  // EL AUMENTO ES ECONOMÍA Y NO JUEGO. Su estado de trabajo es `RoundState.betOffer` y quien lo
  // audita es el historial de soporte, que guarda el payload entero de los dos comandos. Meterlo
  // acá sería una tercera copia, y le colgaría a cada ficha puesta un `level` y un `accepted` que
  // para ella son siempre cero — que es exactamente la forma de truco, donde los cantos SÍ son
  // jugadas de la mano. Acá no lo son, y v1 tampoco los mete en `historyMoves`.
  it("no apunta la propuesta ni la respuesta del aumento", () => {
    const e = engineWithHands(betHands, [], { betLevels: LEVELS });
    e.start();

    e.proposeBet("u2", 2);
    e.respondBet("u1", true);

    expect([...e.round().pastMoves]).toEqual([]);
    expect(e.match.acceptedBetLevel).toBe(2);
  });

  // EL RETIRO NO ES UNA JUGADA, y su registro ya existe en otro lado.
  it("no apunta el abandono, que vive en el asiento y en su evento", () => {
    const e = engineWithHands(blockedHands, [[3, 3]]);
    e.start();

    e.abandon("u1");

    expect([...e.round().pastMoves]).toEqual([]);
    expect(e.match.players.find((player) => player.playerId === "u1")?.hasAbandoned).toBe(true);
  });

  // NO HAY BOCA DEL RELOJ, y la ausencia es una afirmación: el reloj nunca juega por nadie. Al
  // vencer el turno RETIRA al que se calló, y eso no es una jugada. El día que haya bots o jugada
  // automática, este test es el que hay que cambiar a conciencia.
  it("no apunta nada cuando el turno vence: el reloj retira, no juega", () => {
    const e = engineWithHands(blockedHands, [[3, 3]]);
    e.start();

    e.fireTimeout();

    expect([...e.round().pastMoves]).toEqual([]);
  });

  // LA CEREMONIA DEL REPARTO TAMPOCO. Levantar las fichas es el control de presencia de la ventana
  // de reparto (reglas §3.1), no un movimiento sobre el tablero.
  it("no apunta el levantar las fichas", () => {
    const e = engineWithHands(blockedHands, [[3, 3]], { isDealWindowEnabled: true });
    e.start();

    e.revealTiles("u1");
    e.revealTiles("u2");

    expect([...e.round().pastMoves]).toEqual([]);
    expect(e.round().phase).toBe("PLAYING");
  });
});
