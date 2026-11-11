import { findBareAmounts } from "@/shared/tests/find-bare-amounts";
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
      bet: { uc: "10.0000" },
      prize: { uc: "18.0000" },
      score: 104,
      result: "win",
      freeRoom: false,
      playersQuantity: 2,
      gameModeName: "Clásica",
    });
  });

  it("el que no ganó no ve premio", () => {
    expect(rowOf("u2", finished)).toMatchObject({
      bet: { uc: "10.0000" },
      prize: { uc: "0.0000" },
      score: 40,
      result: "abandoned",
    });
  });

  // UNA PARTIDA ABORTADA NO MOVIÓ PLATA PARA ÉL, diga lo que diga el asiento: el reembolso lo decide el
  // orquestador, y mostrar la entrada sería mostrar un cobro que se devolvió.
  it("la cancelada va sin entrada ni premio", () => {
    expect(rowOf("u1", aborted)).toMatchObject({
      bet: { uc: "0.0000" },
      prize: { uc: "0.0000" },
      result: "canceled",
    });
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

// LA FILA EN SU MONEDA: lo que el cierre congeló, con las mismas dos reglas que la de UC, en la llave de
// su moneda junto a `uc`. Sólo si el asiento se sentó con precio.
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
      bet: { ves: "4000.00", uc: "20.0000" },
      prize: { ves: "7200.00", uc: "36.0000" },
    });
  });

  it("el que no ganó ve lo que pagó y ningún premio", () => {
    expect(rowOf("u2", priced)).toMatchObject({
      result: "abandoned",
      bet: { ves: "4000.00", uc: "20.0000" },
      prize: { ves: "0.00", uc: "0.0000" },
    });
    const lost = {
      ...priced,
      players: [priced.players[0], { ...priced.players[1], exit: undefined }],
    };
    expect(rowOf("u2", lost)).toMatchObject({
      result: "lose",
      bet: { ves: "4000.00", uc: "20.0000" },
    });
  });

  // LA CANCELADA NO MOVIÓ PLATA, tampoco en su moneda, diga lo que diga el asiento.
  it("la cancelada va en cero en su moneda", () => {
    const canceled = { ...priced, status: "aborted", winnerIds: [] };
    expect(rowOf("u1", canceled)).toMatchObject({
      result: "canceled",
      bet: { ves: "0.00", uc: "0.0000" },
      prize: { ves: "0.00", uc: "0.0000" },
    });
    // Y LA QUE SE ABORTÓ ANTES DE ABRIR, que sólo tiene los asientos del armado.
    const { players, ...bare } = canceled;
    expect(rowOf("u1", bare)).toMatchObject({
      result: "canceled",
      bet: { ves: "0.00", uc: "0.0000" },
    });
  });

  // SIN PRECIO, `{ uc }` SOLO: el dominó no sabe cuánto fue en la otra moneda y no lo inventa. Y nunca
  // los campos de antes (`currency`, `*InPlayerCurrency`) ni un monto suelto.
  it("un asiento sin precio sale en `{ uc }`, y ninguna fila lleva los campos de antes", () => {
    for (const row of [rowOf("u1", finished), rowOf("u2", finished), rowOf("u1", aborted)]) {
      expect(Object.keys(row.bet)).toEqual(["uc"]);
      expect(Object.keys(row.prize)).toEqual(["uc"]);
    }
    const rows = [rowOf("u1", priced), rowOf("u2", priced), rowOf("u1", finished)];
    expect(findBareAmounts(rows, ["bet", "prize"])).toEqual([]);
    for (const row of rows) {
      expect(row).not.toHaveProperty("currency");
      expect(row).not.toHaveProperty("betInPlayerCurrency");
      expect(row).not.toHaveProperty("prizeInPlayerCurrency");
    }
  });

  // CON LOS DECIMALES DE LA MONEDA en el precio, el texto congelado se rellena (nunca se recorta).
  it("rellena con los decimales de la moneda si el precio los trae", () => {
    const padded = {
      ...priced,
      players: priced.players.map((player) => ({
        ...player,
        price: { ...price, decimals: 3 },
      })),
    };
    expect(rowOf("u1", padded)).toMatchObject({
      bet: { ves: "4000.000", uc: "20.0000" },
      prize: { ves: "7200.000", uc: "36.0000" },
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
