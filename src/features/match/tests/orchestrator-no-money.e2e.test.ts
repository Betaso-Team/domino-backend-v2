import { rootContainer } from "@/di-container";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DominoMatchConfig } from "../core/config";
import { BetCharger } from "../network";
import type { BetLevelBook } from "../network";
import type { StandingsFeeds } from "../network/standings";
import { act, bootServer, seatPair, seatPairAsMatchmaking, waitUntil } from "./e2e-harness";

const PORT = 2607;

// UNA MESA DEL ORQUESTADOR NO MUEVE PLATA EN DOMINÓ NI REPORTA A BETASO hasta que el Plan 3 lo
// decida: el dinero lo mueve el orquestador y los `sub` de billing-auth no existen en el ranking ni
// en la liga de Betaso. Cada test cruza la mesa por request contra la del emparejador propio, que
// SIGUE haciendo las dos cosas: la diferencia entre ambas es lo que se mide.
const LEVELS = [{ level: 2, extra: 1, additionalPoints: 1 }] as const;

describe("las mesas del orquestador no mueven plata ni reportan resultados", () => {
  let server: Awaited<ReturnType<typeof bootServer>>;
  const levelsOf = vi.fn(async (_gameModeId: string) => LEVELS);
  const won = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  let previousBook: BetLevelBook;
  let previousFeeds: StandingsFeeds;

  beforeAll(async () => {
    server = await bootServer(PORT);
    previousBook = rootContainer.resolve<BetLevelBook>("BetLevelBook");
    previousFeeds = rootContainer.resolve<StandingsFeeds>("StandingsFeeds");
    rootContainer.register<BetLevelBook>("BetLevelBook", { useValue: { levelsOf } });
    rootContainer.register<StandingsFeeds>("StandingsFeeds", {
      useValue: { ranking: { won }, leagues: { record } },
    });
  });
  afterAll(async () => {
    rootContainer.register<BetLevelBook>("BetLevelBook", { useValue: previousBook });
    rootContainer.register<StandingsFeeds>("StandingsFeeds", { useValue: previousFeeds });
    await server.shutdown();
  });
  beforeEach(() => {
    levelsOf.mockClear();
    won.mockClear();
    record.mockClear();
  });
  afterEach(async () => {
    await server.cleanup();
    vi.restoreAllMocks();
  });

  const configOfRoom = (roomId: string) =>
    (server.getRoomById(roomId) as unknown as { config: DominoMatchConfig }).config;

  it("una mesa por request no ofrece niveles de apuesta ni engancha el cobro", async () => {
    const sinkFor = vi.spyOn(rootContainer.resolve(BetCharger), "sinkFor");
    const match = await seatPair(server, ["n1", "n2"]);
    expect(levelsOf).not.toHaveBeenCalled();
    expect(configOfRoom(match.roomId).betLevels).toEqual([]);
    expect(sinkFor).not.toHaveBeenCalled();
  });

  it("la mesa del emparejador propio sigue ofreciendo niveles y cobrando aumentos", async () => {
    const sinkFor = vi.spyOn(rootContainer.resolve(BetCharger), "sinkFor");
    const match = await seatPairAsMatchmaking(server, ["m1", "m2"], {
      entryFee: 0,
      prize: 0,
      isFreeRoom: true,
    });
    expect(levelsOf).toHaveBeenCalledTimes(1);
    expect(configOfRoom(match.roomId).betLevels).toEqual(LEVELS);
    expect(sinkFor).toHaveBeenCalledTimes(1);
  });

  it("al resolverse, una mesa por request no publica el ranking ni llama a la liga", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await act(match, "r1", "ABANDON");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);
    expect(won).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("al resolverse, la mesa del emparejador propio sí llama a la liga", async () => {
    const match = await seatPairAsMatchmaking(server, ["l1", "l2"], {
      entryFee: 0,
      prize: 0,
      isFreeRoom: true,
    });
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await act(match, "l1", "ABANDON");
    await waitUntil(() => record.mock.calls.length === 1, 3_000);
  });
});
