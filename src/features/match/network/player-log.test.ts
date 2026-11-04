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
      roomId: "room-1",
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

// LA FILA EN SU MONEDA: lo que el cierre congeló, con las mismas dos reglas que la de UC. Los tres campos
// van juntos, y sólo si el asiento se sentó con precio.
describe("rowOf: en la moneda del jugador", () => {
  const price = {
    currency: "VES",
    rate: "200",
    entry: "2000.00",
    prize: "3600.00",
    levels: [{ level: 2, entry: "2000.00", prize: "7200.00" }],
  };
  // GANÓ CON UN AUMENTO A x2 (u1) y el otro se fue (u2): es lo que `matchCloseOf` deja en cada asiento.
  const [winner, loser] = finished.players;
  const priced = {
    ...finished,
    seats: finished.seats.map((seat) => ({ ...seat, price })),
    players: [
      {
        ...winner,
        price,
        chargedInUC: 20,
        prizePaidInUC: 36,
        chargedInPlayerCurrency: "4000.00",
        prizePaidInPlayerCurrency: "7200.00",
      },
      {
        ...loser,
        price,
        chargedInUC: 20,
        prizePaidInUC: 0,
        chargedInPlayerCurrency: "4000.00",
        prizePaidInPlayerCurrency: "0.00",
      },
    ],
  };

  it("el que ganó con un aumento ve la entrada más el aumento y el premio del nivel", () => {
    expect(rowOf("u1", priced)).toMatchObject({
      result: "win",
      bet: 20,
      prize: 36,
      currency: "VES",
      betInPlayerCurrency: "4000.00",
      prizeInPlayerCurrency: "7200.00",
    });
  });

  it("el que no ganó ve lo que pagó y ningún premio", () => {
    expect(rowOf("u2", priced)).toMatchObject({
      result: "abandoned",
      bet: 20,
      prize: 0,
      currency: "VES",
      betInPlayerCurrency: "4000.00",
      prizeInPlayerCurrency: "0.00",
    });
    const lost = {
      ...priced,
      players: [priced.players[0], { ...priced.players[1], exit: undefined }],
    };
    expect(rowOf("u2", lost)).toMatchObject({ result: "lose", betInPlayerCurrency: "4000.00" });
  });

  // LA CANCELADA NO MOVIÓ PLATA, tampoco en su moneda, diga lo que diga el asiento.
  it("la cancelada va en cero en su moneda", () => {
    const canceled = { ...priced, status: "aborted", winnerIds: [] };
    expect(rowOf("u1", canceled)).toMatchObject({
      result: "canceled",
      bet: 0,
      prize: 0,
      currency: "VES",
      betInPlayerCurrency: "0.00",
      prizeInPlayerCurrency: "0.00",
    });
    // Y LA QUE SE ABORTÓ ANTES DE ABRIR, que sólo tiene los asientos del armado.
    const { players, ...bare } = canceled;
    expect(rowOf("u1", bare)).toMatchObject({ result: "canceled", betInPlayerCurrency: "0.00" });
  });

  // SIN PRECIO, LA FILA ES LA DE SIEMPRE: ni un campo nuevo, ni vacío.
  it("un asiento sin precio no trae ningún campo nuevo", () => {
    for (const row of [rowOf("u1", finished), rowOf("u2", finished), rowOf("u1", aborted)]) {
      expect(row).not.toHaveProperty("currency");
      expect(row).not.toHaveProperty("betInPlayerCurrency");
      expect(row).not.toHaveProperty("prizeInPlayerCurrency");
    }
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
