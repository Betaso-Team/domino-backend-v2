import { decimal, stakeAt } from "@/shared/money";
import { findBadAmounts } from "@/shared/tests/find-bad-amounts";
import { describe, expect, it } from "vitest";
import { seatPriceView, seatText, storedUcOf, ucText, wireEventOf } from "../amounts";
import { type RecordAudience, entryView, recordView } from "../record-view";

const TABLEA: RecordAudience = { kind: "tablea" };

// LA CONVENCIÓN DE MONTOS v2 EN LA FRONTERA DEL DOMINÓ: lo que `network/amounts.ts` y `record-view.ts`
// emiten. Las llaves de plata de cada forma, para `findBadAmounts`.
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

describe("ucText: un monto en UC como texto", () => {
  it.each([
    ["125", "125.0000"],
    ["1.5", "1.5000"],
    ["0", "0.0000"],
    ["0.0000001", "0.0000001"],
  ])("%s → %j", (amount, expected) => {
    expect(ucText(decimal(amount))).toBe(expected);
  });

  // NUNCA REDONDEA, y nunca pasa por coma flotante: el premio a x6 de una mesa de 0.02 es 0.12, que es
  // lo que el orquestador calcula con la misma fórmula (en `number` era 0.12000000000000001).
  it("es el decimal exacto de la fórmula", () => {
    expect(ucText(stakeAt(decimal("0.02"), 6))).toBe("0.1200");
  });
});

describe("storedUcOf: un monto en UC del registro, de cualquier época", () => {
  it.each([
    [125, "125"],
    [1.5, "1.5"],
    [0.12000000000000001, "0.12000000000000001"],
    ["125.0000", "125"],
    ["0.1200", "0.12"],
  ])("%j → %s", (stored, expected) => {
    expect(storedUcOf(stored)?.toString()).toBe(expected);
  });

  it.each([undefined, null, -1, Number.NaN, "1e3", "-1", "", {}])("%j no es un monto", (value) => {
    expect(storedUcOf(value)).toBeUndefined();
  });
});

describe("seatText: un monto en la moneda del asiento", () => {
  it("sin decimales sale como vino", () => {
    expect(seatText({ currency: "VES" }, "200")).toBe("200");
  });

  it("rellena con los decimales de la moneda y nunca recorta", () => {
    expect(seatText({ currency: "VES", decimals: 2 }, "200")).toBe("200.00");
    expect(seatText({ currency: "USD", decimals: 2 }, "1.555")).toBe("1.555");
  });

  it("un asiento que paga en UC lleva los 4 decimales de UC", () => {
    expect(seatText({ currency: "UC" }, "2")).toBe("2.0000");
  });
});

describe("seatPriceView: el precio de un asiento", () => {
  const price = {
    currency: "VES",
    rate: "200",
    entry: "200",
    prize: "360.00",
    levels: [
      { level: 2, entry: "200.00", prize: "720.00" },
      { level: 3, entry: "400.00", prize: "1080.5" },
    ],
    decimals: 2,
  };

  it("una entidad en su moneda, con la tasa de la mesa y sin `uc`", () => {
    const view = seatPriceView(price, "rate-1");
    expect(view).toEqual({
      currency: "VES",
      rateId: "rate-1",
      rate: "200",
      entry: "200.00",
      prize: "360.00",
      levels: [
        { level: 2, entry: "200.00", prize: "720.00" },
        { level: 3, entry: "400.00", prize: "1080.50" },
      ],
    });
    expect(view).not.toHaveProperty("decimals");
    expect(JSON.stringify(view)).not.toContain('"uc"');
    expect(findBadAmounts(view, RECORD_KEYS)).toEqual([]);
  });

  it("el código de moneda va tal cual", () => {
    expect(seatPriceView({ ...price, currency: "USDT" }, "r").currency).toBe("USDT");
  });
});

describe("wireEventOf: los eventos que difunde la sala", () => {
  it("`MULTIPLIER_AGREED` lleva lo que cuesta aceptar en UC, como texto", () => {
    const event = {
      type: "MULTIPLIER_AGREED",
      level: 2,
      extra: 1,
      additionalEntryFee: decimal("125"),
      playerIds: ["seat-1", "seat-2"],
    } as const;
    expect(wireEventOf(event)).toEqual({
      ...event,
      currency: "UC",
      additionalEntryFee: "125.0000",
    });
    expect(findBadAmounts(wireEventOf(event), RECORD_KEYS)).toEqual([]);
    // El evento interno no se toca: lo sigue leyendo el cobro del aumento.
    expect(event.additionalEntryFee.eq(decimal("125"))).toBe(true);
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
    entry: "25000",
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
        prizePaidInPlayerCurrency: "100000",
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
    rateId: "rate-1",
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

  const priceView = {
    currency: "VES",
    rateId: "rate-1",
    rate: "200",
    entry: "25000.00",
    prize: "50000.00",
    levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
  };

  it("la mesa en UC y cada asiento en su moneda, con la tasa de la partida", () => {
    const view = recordView(stored, TABLEA) as typeof stored & Record<string, unknown>;
    expect(view.table).toEqual({
      gameModeId: "g",
      name: "Clásica",
      currency: "UC",
      entryFee: "125.0000",
      prize: "250.0000",
      isFree: false,
    });
    expect(view.seats).toEqual([
      { id: "seat-1", userId: "u1", currency: "VES", price: priceView },
      { id: "seat-2", userId: "u2", currency: "VES" },
    ]);
    expect(view.players).toEqual([
      {
        currency: "VES",
        rateId: "rate-1",
        id: "seat-1",
        userId: "u1",
        price: priceView,
        finalScore: 100,
        charged: "50000.00",
        prizePaid: "100000.00",
      },
      // SIN PRECIO, EN UC: el dominó no sabe cuánto fue en su moneda, y no lo inventa.
      {
        currency: "UC",
        rateId: "rate-1",
        id: "seat-2",
        userId: "u2",
        finalScore: 3,
        charged: "250.0000",
        prizePaid: "0.0000",
      },
    ]);
    expect(view.betMultiplier).toEqual({
      offeredValues: [2],
      finalValue: 2,
      currency: "UC",
      resultingEntryFee: "250.0000",
      resultingPrize: "500.0000",
      proposals: [],
    });
    expect(view.timeline[1]?.payload).toEqual({
      type: "MULTIPLIER_AGREED",
      level: 2,
      extra: 1,
      currency: "UC",
      additionalEntryFee: "125.0000",
    });
    expect(view.rankingMultiplier).toEqual(stored.rankingMultiplier);
  });

  // LOS DOCUMENTOS NUEVOS GUARDAN LOS MONTOS EN UC COMO TEXTO, los de antes como número, y no se migra
  // nada: los dos se leen igual.
  it("un documento nuevo, con los montos en UC como texto, se lee igual que uno de antes", () => {
    const text = (value: number) => ucText(decimal(String(value)));
    const [first, second] = stored.players;
    const asText = {
      ...stored,
      table: { ...stored.table, entryFeeInUC: text(125), prizeInUC: text(250) },
      players: [
        { ...first, chargedInUC: text(250), prizePaidInUC: text(500) },
        { ...second, chargedInUC: text(250), prizePaidInUC: text(0) },
      ],
      betMultiplier: {
        ...stored.betMultiplier,
        resultingEntryFeeInUC: text(250),
        resultingPrizeInUC: text(500),
      },
      timeline: [
        stored.timeline[0],
        {
          ...stored.timeline[1],
          payload: { ...stored.timeline[1]?.payload, additionalEntryFee: text(125) },
        },
      ],
    };
    expect(recordView(asText, TABLEA)).toEqual(recordView(stored, TABLEA));
  });

  it("un asiento con precio que el cierre no dejó en su moneda queda en UC", () => {
    const {
      chargedInPlayerCurrency: _c,
      prizePaidInPlayerCurrency: _p,
      ...seat
    } = stored.players[0] as (typeof stored.players)[0];
    const view = recordView({ ...stored, players: [seat] }, TABLEA) as Record<string, unknown>;
    expect(view.players).toEqual([
      {
        currency: "UC",
        rateId: "rate-1",
        id: "seat-1",
        userId: "u1",
        price: priceView,
        finalScore: 100,
        charged: "250.0000",
        prizePaid: "500.0000",
      },
    ]);
  });

  it("una partida abierta (sin `rateId` todavía) publica el precio sin tasa", () => {
    const { rateId: _r, players: _p, ...opened } = stored;
    const view = recordView(opened, TABLEA) as Record<string, unknown>;
    const [first] = view.seats as Record<string, unknown>[];
    const { rateId: _none, ...withoutRate } = priceView;
    expect(first?.price).toEqual(withoutRate);
  });

  it("no deja ningún monto fuera de la convención ni ninguna llave de antes", () => {
    const text = JSON.stringify(recordView(stored, TABLEA));
    expect(findBadAmounts(recordView(stored, TABLEA), RECORD_KEYS)).toEqual([]);
    for (const old of ["InUC", "InPlayerCurrency", '"uc"', '"ves"']) {
      expect(text).not.toContain(old);
    }
  });

  it("no toca el documento guardado", () => {
    const before = JSON.stringify(stored);
    recordView(stored, TABLEA);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("un documento de la forma vieja, o una fila sin montos, sale como está", () => {
    const legacy = { _id: "x", matchId: "m-0", entries: [{ seq: 1, type: "PLACE_TILE" }] };
    expect(recordView(legacy, TABLEA)).toEqual(legacy);
    const summary = { _id: "y", matchId: "m-2", status: "started" };
    expect(recordView(summary, TABLEA)).toEqual(summary);
  });

  it("una entrada de la timeline sin plata pasa tal cual", () => {
    const entry = { seq: 1, type: "PLACE_TILE", payload: { tile: [1, 2] } };
    expect(entryView(entry)).toBe(entry);
  });
});
