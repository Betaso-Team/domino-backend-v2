import { describe, expect, it } from "vitest";
import { paginated, resultFor, rowOf } from "./player-log";
import { CLOSING } from "./transports/tests/history-contract";

// EL DOCUMENTO COMO LO GUARDAN LOS ADAPTADORES: los instantes ya son fechas (`stored-record.ts`).
const ENDED_AT = new Date("2026-10-26T20:00:00.000Z");
const finished = {
  ...CLOSING,
  matchId: "m-1",
  matchEndedAt: ENDED_AT,
  createdAt: new Date("2026-10-26T19:59:00.000Z"),
};
const aborted = { ...finished, status: "aborted", matchEndReason: "TILES_NOT_SEEN", winnerIds: [] };

describe("resultFor: cómo terminó PARA el que pregunta", () => {
  it("el asiento ganador ganó y el otro perdió", () => {
    const won = { ...finished, players: finished.players.map(({ exit, ...p }) => p) };
    expect(resultFor("u1", won)).toBe("win");
    expect(resultFor("u2", won)).toBe("lose");
  });

  it("el que se fue abandonó, y la partida abortada es cancelada para todos", () => {
    expect(resultFor("u2", finished)).toBe("abandoned");
    expect(resultFor("u1", aborted)).toBe("canceled");
    expect(resultFor("u2", aborted)).toBe("canceled");
  });

  // GANAR VA ANTES QUE IRSE: en 4P uno se puede ir y su pareja ganar, y lo que recuerda es que ganó.
  it("el que se fue de un equipo que ganó, ganó", () => {
    const partnerWon = {
      ...finished,
      winnerIds: ["seat-1", "seat-2"],
      players: finished.players,
    };
    expect(resultFor("u2", partnerWon)).toBe("win");
  });

  // LOS GANADORES SON ASIENTOS (`seat-N`), no cuentas: comparar el `userId` contra `winnerIds` daría
  // perdedor a todo el mundo.
  it("cruza la cuenta con su asiento antes de mirar a los ganadores", () => {
    expect(finished.winnerIds).toEqual(["seat-1"]);
    expect(resultFor("u1", finished)).toBe("win");
  });
});

describe("rowOf: la fila desde el asiento del que pregunta", () => {
  it("el ganador ve lo que pagó, lo que cobró, sus puntos y cuándo terminó", () => {
    expect(rowOf("u1", finished)).toEqual({
      id: "m-1",
      playedAt: "2026-10-26T20:00:00.000Z",
      bet: 10,
      prize: 18,
      score: 104,
      result: "win",
      freeRoom: false,
      playersQuantity: 2,
      gameModeName: "Clásica",
    });
  });

  it("el que no ganó no ve premio", () => {
    expect(rowOf("u2", finished)).toMatchObject({
      bet: 10,
      prize: 0,
      score: 40,
      result: "abandoned",
    });
  });

  // UNA PARTIDA ABORTADA NO MOVIÓ PLATA PARA ÉL, diga lo que diga el asiento: el reembolso lo decide el
  // orquestador, y mostrar la entrada sería mostrar un cobro que se devolvió.
  it("la cancelada va sin entrada ni premio", () => {
    expect(rowOf("u1", aborted)).toMatchObject({ bet: 0, prize: 0, result: "canceled" });
  });

  // UNA ABORTADA ANTES DE ABRIR NO TIENE `players` NI `matchEndedAt`: se lee de los asientos y de la fila.
  it("sin jugadores cerrados ni fin, cae en los asientos y en el `updatedAt`", () => {
    const { players, matchEndedAt, ...bare } = aborted;
    const updatedAt = new Date("2026-10-26T21:00:00.000Z");
    expect(rowOf("u1", { ...bare, updatedAt })).toMatchObject({
      playedAt: "2026-10-26T21:00:00.000Z",
      score: 0,
      result: "canceled",
    });
  });
});

describe("paginated: la página con la forma de truco", () => {
  it("dice cuántas hay y si hay otra a cada lado", () => {
    expect(paginated(["a", "b"], 5, 2, 2)).toEqual({
      items: ["a", "b"],
      page: 2,
      perPage: 2,
      totalItems: 5,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(paginated([], 0, 1, 10)).toMatchObject({ totalPages: 0, hasNextPage: false });
  });
});
