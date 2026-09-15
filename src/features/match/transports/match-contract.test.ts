import { describe, expect, it } from "vitest";
import { configOf } from "./match-contract.js";

// LA ÚNICA FRONTERA que valida lo que matchmaking manda, y la que traduce la identidad
// externa —la pareja `{ platformId, userUuid }`— al id opaco con el que el motor juega.
// Todo lo que este test afirma es dinero: la moneda ya cobrada, la tasa de la mesa y los
// montos en enteros de UC (los dos últimos dígitos son decimales: `125 = 1,25 UC`).
const valid = {
  mode: "CASUAL",
  matchId: "m1",
  gameModeId: "classic-2p",
  participants: [
    {
      platformId: "betaso",
      userUuid: "same",
      displayName: "Ada",
      username: "ada",
      profilePicture: "https://img.test/ada.png",
      currency: "VES",
    },
    {
      platformId: "partner",
      userUuid: "same",
      displayName: "Lin",
      currency: "USD",
    },
  ],
  seed: "seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} as const;

describe("configOf", () => {
  it("normaliza identidades externas a ids opacos reproducibles", () => {
    expect(configOf(valid).seats).toEqual([
      { ...valid.participants[0], playerId: "seat-1" },
      { ...valid.participants[1], playerId: "seat-2" },
    ]);
  });

  it("conserva moneda, rateId y enteros UC exactamente", () => {
    const config = configOf(valid);
    expect(config.rateId).toBe(valid.rateId);
    expect(config.entryFeeUcMinor).toBe(125);
    expect(config.prizeUcMinor).toBe(250);
    expect(config.seats.map(({ currency }) => currency)).toEqual(["VES", "USD"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["rateId no UUID", { rateId: "actual" }],
    ["UC fraccionaria", { entryFeeUcMinor: 12.5 }],
    ["UC insegura", { prizeUcMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ["UC negativa", { prizeUcMinor: -1 }],
    [
      "currency vacía",
      { participants: [{ ...valid.participants[0], currency: " " }, valid.participants[1]] },
    ],
    [
      "platformId ausente",
      {
        participants: [{ ...valid.participants[0], platformId: undefined }, valid.participants[1]],
      },
    ],
    [
      "displayName ausente",
      {
        participants: [{ ...valid.participants[0], displayName: undefined }, valid.participants[1]],
      },
    ],
  ])("rechaza %s", (_name, override) => {
    expect(() => configOf({ ...valid, ...override })).toThrow();
  });

  // EL CASO QUE JUSTIFICA LA PAREJA: el mismo UUID puede existir en dos plataformas y ser
  // dos personas distintas con dos billeteras distintas. Lo que no puede repetirse es la
  // pareja entera — eso sería el mismo principal sentado dos veces en la misma mesa.
  it("acepta el mismo userUuid en plataformas distintas y rechaza la pareja duplicada", () => {
    expect(() => configOf(valid)).not.toThrow();
    expect(() =>
      configOf({ ...valid, participants: [valid.participants[0], valid.participants[0]] }),
    ).toThrow(/duplicada/);
  });
});
