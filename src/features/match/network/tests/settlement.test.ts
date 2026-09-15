import { describe, expect, it } from "vitest";
import { createMatchState } from "../../core/engine/genesis.js";
import { configOf } from "../../transports/match-contract.js";
import { settlementOf } from "../settlement.js";

const options = {
  mode: "CASUAL",
  matchId: "money-1",
  gameModeId: "classic-2p",
  participants: [
    { platformId: "betaso", userUuid: "same", displayName: "Ada", currency: "VES" },
    { platformId: "partner", userUuid: "same", displayName: "Lin", currency: "USD" },
  ],
  seed: "money-seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} as const;

const config = configOf(options);
const matchOf = () => createMatchState(config);

describe("settlementOf", () => {
  it("premia al ganador con su pareja y la moneda cobrada", () => {
    const match = matchOf();
    const winnerTeamId = match.players[0]?.teamId as "A" | "B";
    expect(
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, config),
    ).toEqual({
      matchId: "money-1",
      rateId: options.rateId,
      kind: "REWARD",
      entries: [
        {
          platformId: "betaso",
          userUuid: "same",
          currency: "VES",
          amountUcMinor: 250,
          idempotencyKey: JSON.stringify(["money-1", "REWARD", "betaso", "same"]),
        },
      ],
    });
  });

  it("reembolsa a todos un aborto en la moneda original", () => {
    const match = matchOf();
    const result = settlementOf({ type: "MATCH_ABORTED", reason: "INTERRUPTED" }, match, config);
    expect(result?.kind).toBe("REFUND");
    expect(result?.entries).toEqual([
      expect.objectContaining({ platformId: "betaso", currency: "VES", amountUcMinor: 125 }),
      expect.objectContaining({ platformId: "partner", currency: "USD", amountUcMinor: 125 }),
    ]);
  });

  it("no proyecta eventos no terminales y rechaza un ganador imposible", () => {
    const match = matchOf();
    expect(
      settlementOf({ type: "PLAYER_DISCONNECTED", playerId: "seat-1" }, match, config),
    ).toBeUndefined();
    for (const player of match.players) player.teamId = "B";
    expect(() =>
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }, match, config),
    ).toThrow(/exactamente un ganador/);
  });

  // LA OTRA MITAD DE LA GUARDA, y es la que puede pasar de verdad: `configOf` acepta cuatro
  // participantes, así que una mesa con dos ganadores del mismo equipo es alcanzable hoy.
  // Sin esta aserción el guard podía ser `=== 0` y la suite seguía verde — pagando el premio
  // ENTERO a cada uno de los dos, o sea el doble de lo que la mesa cobró.
  it("rechaza varios ganadores en vez de pagarle el premio entero a cada uno", () => {
    const match = matchOf();
    for (const player of match.players) player.teamId = "A";
    expect(() =>
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }, match, config),
    ).toThrow(/exactamente un ganador, recibió 2/);
  });
});
