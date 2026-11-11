import { findBareAmounts } from "@/shared/tests/find-bare-amounts";
import { describe, expect, it } from "vitest";
import { seatMoneyOf, seatPriceView, ucOf, wireEventOf } from "../amounts";
import { entryView, recordView } from "../record-view";

// LA CONVENCIÓN DE MONTOS EN LA FRONTERA DEL DOMINÓ: lo que `network/amounts.ts` y `record-view.ts`
// emiten. Las llaves de plata de cada forma, para `findBareAmounts`.
const RECORD_KEYS = [
  "entryFee",
  "prize",
  "entry",
  "charged",
  "prizePaid",
  "resultingEntryFee",
  "resultingPrize",
  "additionalEntryFee",
];

describe("ucOf: un número en UC como `{ uc }`", () => {
  it.each([
    [125, { uc: "125.0000" }],
    [1.5, { uc: "1.5000" }],
    [0, { uc: "0.0000" }],
    [1e-7, { uc: "0.0000001" }],
  ])("%s → %j", (amount, expected) => {
    expect(ucOf(amount)).toEqual(expected);
  });

  // NUNCA REDONDEA: el ruido de un producto en coma flotante vuelve al MISMO número, que es lo que el
  // orquestador compara contra su planilla.
  it("conserva todos los dígitos y vuelve al mismo número", () => {
    const noisy = 0.1 + 0.1 * 2;
    expect(Number(ucOf(noisy).uc)).toBe(noisy);
  });
});

describe("seatMoneyOf: un monto en la moneda del asiento", () => {
  it("la moneda en minúsculas primero, `uc` después", () => {
    const value = seatMoneyOf({ currency: "VES" }, "200", "2");
    expect(JSON.stringify(value)).toBe('{"ves":"200","uc":"2.0000"}');
  });

  it("rellena con los decimales de la moneda y nunca recorta", () => {
    expect(seatMoneyOf({ currency: "VES", decimals: 2 }, "200", "2")).toEqual({
      ves: "200.00",
      uc: "2.0000",
    });
    expect(seatMoneyOf({ currency: "USD", decimals: 2 }, "1.555", "1.555")).toEqual({
      usd: "1.555",
      uc: "1.5550",
    });
  });

  it("un asiento que paga en UC es `{ uc }` solo", () => {
    expect(seatMoneyOf({ currency: "UC" }, "2", "2")).toEqual({ uc: "2.0000" });
  });
});

describe("seatPriceView: el precio de un asiento", () => {
  const price = {
    currency: "VES",
    rate: "200",
    entry: "200.00",
    prize: "360.00",
    levels: [
      { level: 2, entry: "200.00", prize: "720.00" },
      { level: 3, entry: "400.00", prize: "1080.00" },
    ],
  };

  // EL `uc` SALE DE LA MESA con la regla del cobro: subir a N cobra entryFee × (N − 1) y paga prize × N.
  it("cada monto con su `uc`, exacto y sin la `currency` hermana", () => {
    const view = seatPriceView(price, { entryFee: 0.1, prize: 0.18 });
    expect(view).toEqual({
      rate: "200",
      entry: { ves: "200.00", uc: "0.1000" },
      prize: { ves: "360.00", uc: "0.1800" },
      levels: [
        {
          level: 2,
          entry: { ves: "200.00", uc: "0.1000" },
          prize: { ves: "720.00", uc: "0.3600" },
        },
        {
          level: 3,
          entry: { ves: "400.00", uc: "0.2000" },
          prize: { ves: "1080.00", uc: "0.5400" },
        },
      ],
    });
    expect(view).not.toHaveProperty("currency");
    expect(findBareAmounts(view, RECORD_KEYS)).toEqual([]);
  });
});

describe("wireEventOf: los eventos que difunde la sala", () => {
  it("`MULTIPLIER_AGREED` lleva lo que cuesta aceptar como `{ uc }`", () => {
    const event = {
      type: "MULTIPLIER_AGREED",
      level: 2,
      extra: 1,
      additionalEntryFee: 125,
      playerIds: ["seat-1", "seat-2"],
    } as const;
    expect(wireEventOf(event)).toEqual({ ...event, additionalEntryFee: { uc: "125.0000" } });
    // El evento interno no se toca: lo sigue leyendo el cobro del aumento.
    expect(event.additionalEntryFee).toBe(125);
  });

  it("los demás pasan tal cual", () => {
    const event = { type: "MULTIPLIER_REVOKED", level: 2 } as const;
    expect(wireEventOf(event)).toBe(event);
  });
});

describe("recordView: el registro como lo lee el panel", () => {
  const price = {
    currency: "VES",
    rate: "200",
    entry: "25000.00",
    prize: "50000.00",
    levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
    decimals: 2,
  };
  const stored = {
    _id: "6560f0000000000000000001",
    matchId: "m-1",
    table: { gameModeId: "g", name: "Clásica", entryFeeInUC: 125, prizeInUC: 250, isFree: false },
    seats: [
      { id: "seat-1", userId: "u1", currency: "VES", price },
      { id: "seat-2", userId: "u2", currency: "VES" },
    ],
    players: [
      {
        id: "seat-1",
        userId: "u1",
        currency: "VES",
        price,
        finalScore: 100,
        chargedInUC: 250,
        prizePaidInUC: 500,
        chargedInPlayerCurrency: "50000.00",
        prizePaidInPlayerCurrency: "100000.00",
      },
      {
        id: "seat-2",
        userId: "u2",
        currency: "VES",
        finalScore: 3,
        chargedInUC: 250,
        prizePaidInUC: 0,
      },
    ],
    betMultiplier: {
      offeredValues: [2],
      finalValue: 2,
      resultingEntryFeeInUC: 250,
      resultingPrizeInUC: 500,
      proposals: [],
    },
    rankingMultiplier: { base: 1, extra: 1, final: 2 },
    timeline: [
      { seq: 1, type: "PROPOSE_BET_MULTIPLIER", payload: { level: 2 } },
      {
        seq: 2,
        type: "MULTIPLIER_AGREED",
        payload: { type: "MULTIPLIER_AGREED", level: 2, extra: 1, additionalEntryFee: 125 },
      },
    ],
  };

  it("une los montos en UC y en la moneda del jugador, con su tasa", () => {
    const view = recordView(stored) as typeof stored & Record<string, unknown>;
    expect(view.table).toEqual({
      gameModeId: "g",
      name: "Clásica",
      entryFee: { uc: "125.0000" },
      prize: { uc: "250.0000" },
      isFree: false,
    });
    expect(view.players).toEqual([
      {
        id: "seat-1",
        userId: "u1",
        currency: "VES",
        price: {
          rate: "200",
          entry: { ves: "25000.00", uc: "125.0000" },
          prize: { ves: "50000.00", uc: "250.0000" },
          levels: [
            {
              level: 2,
              entry: { ves: "25000.00", uc: "125.0000" },
              prize: { ves: "100000.00", uc: "500.0000" },
            },
          ],
        },
        finalScore: 100,
        charged: { ves: "50000.00", uc: "250.0000" },
        prizePaid: { ves: "100000.00", uc: "500.0000" },
      },
      {
        id: "seat-2",
        userId: "u2",
        currency: "VES",
        finalScore: 3,
        charged: { uc: "250.0000" },
        prizePaid: { uc: "0.0000" },
      },
    ]);
    expect(view.betMultiplier).toEqual({
      offeredValues: [2],
      finalValue: 2,
      resultingEntryFee: { uc: "250.0000" },
      resultingPrize: { uc: "500.0000" },
      proposals: [],
    });
    expect(view.timeline[1]?.payload).toMatchObject({ additionalEntryFee: { uc: "125.0000" } });
    expect(view.rankingMultiplier).toEqual(stored.rankingMultiplier);
  });

  it("no deja ningún monto suelto ni ninguna llave de antes", () => {
    const text = JSON.stringify(recordView(stored));
    expect(findBareAmounts(recordView(stored), RECORD_KEYS)).toEqual([]);
    for (const old of ["InUC", "InPlayerCurrency", '"currency":"VES","rate"']) {
      expect(text).not.toContain(old);
    }
  });

  it("no toca el documento guardado", () => {
    const before = JSON.stringify(stored);
    recordView(stored);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("un documento de la forma vieja, o una fila sin montos, sale como está", () => {
    const legacy = { _id: "x", matchId: "m-0", entries: [{ seq: 1, type: "PLACE_TILE" }] };
    expect(recordView(legacy)).toEqual(legacy);
    const summary = { _id: "y", matchId: "m-2", status: "started" };
    expect(recordView(summary)).toEqual(summary);
  });

  it("una entrada de la timeline sin plata pasa tal cual", () => {
    const entry = { seq: 1, type: "PLACE_TILE", payload: { tile: [1, 2] } };
    expect(entryView(entry)).toBe(entry);
  });
});
