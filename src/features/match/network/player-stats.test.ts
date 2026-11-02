import { describe, expect, it } from "vitest";
import { linesOf } from "./player-stats";

const ENDED = 1_700_000_000_000;

const document = (over: Record<string, unknown> = {}) => ({
  status: "finished",
  matchEndedAt: new Date(ENDED),
  matchConfig: { playersQuantity: 2 },
  winnerIds: ["seat-1"],
  players: [
    { id: "seat-1", userId: "ana" },
    { id: "seat-2", userId: "beto" },
  ],
  ...over,
});

describe("linesOf", () => {
  it("da una línea por jugador de una 2P terminada", () => {
    expect(linesOf(document())).toEqual([
      { userId: "ana", result: "win", fourPlayers: false, endedAt: new Date(ENDED) },
      { userId: "beto", result: "lose", fourPlayers: false, endedAt: new Date(ENDED) },
    ]);
  });

  it("el que se fue sin ganar abandonó", () => {
    const lines = linesOf(
      document({
        players: [
          { id: "seat-1", userId: "ana" },
          { id: "seat-2", userId: "beto", exit: { reason: "ABANDON" } },
        ],
      }),
    );
    expect(lines.find((l) => l.userId === "beto")?.result).toBe("abandoned");
  });

  it("en 4P el que se fue y cuyo equipo ganó, ganó", () => {
    const lines = linesOf(
      document({
        matchConfig: { playersQuantity: 4 },
        winnerIds: ["seat-1", "seat-3"],
        players: [
          { id: "seat-1", userId: "ana" },
          { id: "seat-2", userId: "beto" },
          { id: "seat-3", userId: "cris", exit: { reason: "ABANDON" } },
          { id: "seat-4", userId: "dani" },
        ],
      }),
    );
    expect(lines.find((l) => l.userId === "cris")).toMatchObject({
      result: "win",
      fourPlayers: true,
    });
  });

  it("lee la cantidad de matchConfig aunque table no la traiga", () => {
    const lines = linesOf(document({ table: { name: "x" }, matchConfig: { playersQuantity: 4 } }));
    expect(lines.every((l) => l.fourPlayers)).toBe(true);
  });

  it("sin matchConfig cuenta los asientos de players", () => {
    const lines = linesOf(
      document({
        matchConfig: undefined,
        winnerIds: ["seat-1"],
        players: [1, 2, 3, 4].map((n) => ({ id: `seat-${n}`, userId: `u${n}` })),
      }),
    );
    expect(lines.find((l) => l.result === "win")?.fourPlayers).toBe(true);
  });

  it("una abortada no da líneas", () => {
    expect(linesOf(document({ status: "aborted" }))).toEqual([]);
  });

  it("acepta matchEndedAt como número o como fecha", () => {
    const a = linesOf(document({ matchEndedAt: ENDED }));
    const b = linesOf(document({ matchEndedAt: new Date(ENDED) }));
    expect(a[0]?.endedAt).toEqual(b[0]?.endedAt);
    expect(a[0]?.endedAt).toEqual(new Date(ENDED));
  });

  it("sin matchEndedAt o en curso no da líneas", () => {
    expect(linesOf(document({ matchEndedAt: undefined }))).toEqual([]);
    expect(linesOf(document({ status: "started" }))).toEqual([]);
  });

  it("el mismo userId en dos asientos sale una vez", () => {
    const lines = linesOf(
      document({
        players: [
          { id: "seat-1", userId: "ana" },
          { id: "seat-2", userId: "ana" },
        ],
      }),
    );
    expect(lines).toHaveLength(1);
  });
});
