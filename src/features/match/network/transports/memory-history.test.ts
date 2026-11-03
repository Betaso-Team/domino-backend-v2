import { describe, expect, it } from "vitest";
import { MemoryHistory } from "./memory-history";
import { SETUP, describeHistoryContract, entry } from "./tests/history-contract";
import { describePlayerLogContract } from "./tests/player-log-contract";

// EL MISMO CONTRATO QUE EL ADAPTADOR DE MONGO (`./mongo-history.int.test.ts`), corrido contra el que
// usa la instancia sin base y la suite entera.
describeHistoryContract("MemoryHistory", (options) => new MemoryHistory(options));
describePlayerLogContract("MemoryHistory", (options) => new MemoryHistory(options));

describe("MemoryHistory: lo propio de no tener base", () => {
  // EL TOPE ES LO QUE SE PIERDE ELIGIÉNDOLA, y se mide: sin él un proceso que vive semanas guardaría
  // cada partida que jugó.
  it("guarda las últimas 200 partidas y olvida la más vieja", async () => {
    const history = new MemoryHistory();
    for (let index = 0; index <= 200; index += 1) {
      history.record([entry(1, { matchId: `m-${index}` })]);
    }

    expect((await history.list({ pageSize: 1 })).total).toBe(200);
    expect(await history.of("m-0")).toEqual([]);
    expect(await history.of("m-200")).toHaveLength(1);
  });

  it("dos partidas son dos documentos", async () => {
    const history = new MemoryHistory();
    history.open("m-1", { ...SETUP, matchStartedAt: 1 });
    history.open("m-2", { ...SETUP, roomId: "room-2", matchStartedAt: 1 });

    expect((await history.list({ pageSize: 25 })).items).toHaveLength(2);
    expect(await history.snapshotOf("room-2")).toMatchObject({ matchId: "m-2" });
  });
});
