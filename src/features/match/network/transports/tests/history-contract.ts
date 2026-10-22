import { describe, expect, it } from "vitest";
import type {
  ClosedRound,
  HistoryEntry,
  HistoryPort,
  HistoryReader,
  MatchArchive,
  MatchClosing,
  MatchSetup,
} from "../../history";

// EL CONTRATO DEL REGISTRO, ESCRITO UNA SOLA VEZ Y CORRIDO CONTRA LOS DOS ADAPTADORES, por el criterio
// del catálogo (`features/game-mode/transports/tests/repository-contract.ts`): `MemoryHistory` no es un
// doble —es el de la instancia sin Mongo y el que usa la suite—, así que un documento que en memoria
// sale con otra forma es un `/game-data` distinto entre dos despliegues del mismo servidor.
//
// Lo que NO vive acá es lo que sólo Mongo puede tener: los índices, los documentos de la forma vieja
// —que una instancia sin base nunca tuvo— y el orden físico de los campos. Eso va en
// `../mongo-history.int.test.ts`.
//
// TODOS LOS VERBOS DEL PUERTO SON `void`, así que el contrato espera con `drain()`, que es la única
// pregunta "¿terminaste?" que el puerto ofrece.

export type HistoryHarness = HistoryPort & HistoryReader & MatchArchive;

export const SETUP: MatchSetup = {
  roomId: "room-1",
  table: { gameModeId: "mode-1", name: "Clásica", entryFeeInUC: 10, prizeInUC: 18, isFree: false },
  matchConfig: {
    playersQuantity: 2,
    pointsToWin: 100,
    startingScore: { teamA: 0, teamB: 0 },
    timeoutsInMs: { turnTimeoutMs: 60_000, reconnectionWindowMs: 120_000 },
    seed: "seed-1",
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: true,
    tilesPerPlayer: 7,
    betLevels: [],
    enableBots: false,
    isRematchEnabled: true,
  },
  seats: [
    { id: "seat-1", teamId: "A", seat: 0, userId: "u1", displayName: "Ana", currency: "VES" },
    { id: "seat-2", teamId: "B", seat: 1, userId: "u2", displayName: "Beto", currency: "VES" },
  ],
};

export const CLOSING: MatchClosing = {
  ...SETUP,
  status: "finished",
  matchStartedAt: 1_000,
  matchEndedAt: 61_000,
  matchDurationInMs: 60_000,
  matchEndReason: "SCORE",
  winnerTeamId: "A",
  winnerIds: ["seat-1"],
  rateId: "rate-1",
  players: [
    {
      ...(SETUP.seats[0] as MatchSetup["seats"][number]),
      finalScore: 104,
      chargedInUC: 10,
      prizePaidInUC: 18,
    },
    {
      ...(SETUP.seats[1] as MatchSetup["seats"][number]),
      finalScore: 40,
      chargedInUC: 10,
      prizePaidInUC: 0,
      exit: { reason: "TIMEOUT", at: 30_000, roundNumber: 2 },
    },
  ],
  betMultiplier: {
    offeredValues: [2],
    finalValue: 1,
    proposals: [
      {
        proposedBy: "seat-1",
        respondedBy: "seat-2",
        value: 2,
        outcome: "REJECTED",
        proposedAt: 2_000,
        resolvedAt: 3_000,
        roundNumber: 1,
      },
    ],
  },
  rankingMultiplier: { base: 1, extra: 0, final: 1 },
};

export const ROUND: ClosedRound = {
  roundNumber: 1,
  endReason: "DOMINO",
  starterId: "seat-1",
  hands: [
    { playerId: "seat-1", tiles: [], pips: 0 },
    { playerId: "seat-2", tiles: [{ left: 6, right: 4 }], pips: 10 },
  ],
};

export const entry = (seq: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  matchId: "m-1",
  seq,
  at: 1_700_000_000_000 + seq,
  roundNumber: 1,
  source: "PLAYER",
  kind: "COMMAND",
  type: "PLAY_TILE",
  payload: { playerId: "seat-1" },
  ...over,
});

export function describeHistoryContract(
  name: string,
  harness: () => Promise<HistoryHarness> | HistoryHarness,
): void {
  describe(`${name}: el contrato del registro`, () => {
    it("al abrir: la versión, el armado, el estado `started` y el arranque como fecha", async () => {
      const history = await harness();
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(record).toMatchObject({
        matchId: "m-1",
        version: 2.1,
        status: "started",
        matchStartedAt: new Date(1_000),
        ...SETUP,
      });
      expect(record?.createdAt).toBeInstanceOf(Date);
      expect(record?.updatedAt).toBeInstanceOf(Date);
    });

    it("la timeline y las manos se acumulan en orden, con los instantes como fechas", async () => {
      const history = await harness();
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      history.record([entry(1), entry(2)]);
      history.round("m-1", ROUND);
      history.record([entry(3)]);
      history.round("m-1", { ...ROUND, roundNumber: 2, endReason: "BLOCKED" });
      await history.drain();

      const record = await history.recordOf("m-1");
      const timeline = record?.timeline as { seq: number; at: unknown }[];
      expect(timeline.map(({ seq }) => seq)).toEqual([1, 2, 3]);
      expect(timeline[0]?.at).toEqual(new Date(1_700_000_000_001));
      expect((record?.rounds as ClosedRound[]).map((r) => r.endReason)).toEqual([
        "DOMINO",
        "BLOCKED",
      ]);
      // EL LECTOR DE LA SECUENCIA devuelve epoch ms: el replay usa el `at` como reloj.
      expect((await history.of("m-1")).map(({ at }) => at)).toEqual([
        1_700_000_000_001, 1_700_000_000_002, 1_700_000_000_003,
      ]);
    });

    it("al cerrar: el desenlace con sus instantes como fechas, y los arreglos al final", async () => {
      const history = await harness();
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      history.record([entry(1)]);
      history.round("m-1", ROUND);
      history.close("m-1", CLOSING);
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(record).toMatchObject({
        status: "finished",
        matchStartedAt: new Date(1_000),
        matchEndedAt: new Date(61_000),
        // Las DURACIONES quedan números: son cantidades, no instantes.
        matchDurationInMs: 60_000,
        matchEndReason: "SCORE",
        winnerIds: ["seat-1"],
        rateId: "rate-1",
        players: [{ finalScore: 104 }, { exit: { reason: "TIMEOUT", at: new Date(30_000) } }],
        betMultiplier: {
          proposals: [{ proposedAt: new Date(2_000), resolvedAt: new Date(3_000) }],
        },
      });
      expect(Object.keys(record ?? {}).slice(-2)).toEqual(["rounds", "timeline"]);
      // Lo que llega después del cierre —la ventana de revancha, una caída— sigue entrando.
      history.record([entry(2)]);
      await history.drain();
      expect(await history.of("m-1")).toHaveLength(2);
    });

    // UNA MESA QUE NUNCA SE LLENÓ: el cierre es lo primero que llega, y trae el armado él mismo.
    it("un cierre sin nada antes crea el documento, con el armado y sin arreglos", async () => {
      const history = await harness();
      const { matchStartedAt, matchDurationInMs, ...aborted } = CLOSING;
      history.close("m-1", { ...aborted, status: "aborted", matchEndReason: "NEVER_STARTED" });
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(record).toMatchObject({
        matchId: "m-1",
        version: 2.1,
        status: "aborted",
        roomId: "room-1",
      });
      expect(record).not.toHaveProperty("matchStartedAt");
      expect(record).not.toHaveProperty("timeline");
      expect(record).not.toHaveProperty("rounds");
    });

    // EL REGISTRO NO PUEDE NACER DOS VECES (truco `8d4001a`) ni reescribirse: el primer armado y el
    // primer cierre ganan, y una partida cerrada no vuelve a `started`.
    it("abrir y cerrar son idempotentes: gana el primero, y lo cerrado no se reabre", async () => {
      const history = await harness();
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      history.open("m-1", { ...SETUP, roomId: "otra-sala", matchStartedAt: 9_000 });
      history.close("m-1", CLOSING);
      history.close("m-1", { ...CLOSING, status: "aborted", matchEndReason: "INTERRUPTED" });
      history.open("m-1", { ...SETUP, matchStartedAt: 9_000 });
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(record).toMatchObject({
        roomId: "room-1",
        status: "finished",
        matchEndReason: "SCORE",
        matchStartedAt: new Date(1_000),
      });
      expect((await history.page(1, 25)).total).toBe(1);
    });

    it("las entradas que llegan antes de abrir quedan en el mismo documento", async () => {
      const history = await harness();
      history.record([entry(1, { kind: "EVENT", source: "SYSTEM", type: "PLAYER_DISCONNECTED" })]);
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(record).toMatchObject({ status: "started", roomId: "room-1" });
      expect(record?.timeline).toHaveLength(1);
      expect(Object.keys(record ?? {}).at(-1)).toBe("timeline");
      expect((await history.page(1, 25)).total).toBe(1);
    });

    it("el detalle trae el `_id` como texto; `/game-data` no lo trae", async () => {
      const history = await harness();
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(typeof record?._id).toBe("string");
      expect(String(record?._id)).toMatch(/^[0-9a-f]{24}$/);
      const snapshot = await history.snapshotOf("room-1");
      expect(snapshot).toMatchObject({ matchId: "m-1", status: "started" });
      expect(snapshot).not.toHaveProperty("_id");
    });

    // QUIEN PREGUNTA PUEDE TENER CUALQUIERA DE LOS DOS IDS: la sala, o la partida —que es lo único que
    // tienen los documentos que no guardaban la sala—.
    it("`/game-data` encuentra por sala y, si no, por partida", async () => {
      const history = await harness();
      history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
      history.record([entry(1, { matchId: "m-sin-sala" })]);
      await history.drain();

      expect(await history.snapshotOf("room-1")).toMatchObject({ matchId: "m-1" });
      expect(await history.snapshotOf("m-sin-sala")).toMatchObject({ matchId: "m-sin-sala" });
      expect(await history.snapshotOf("no-existe")).toBeUndefined();
      expect(await history.recordOf("no-existe")).toBeUndefined();
      expect(await history.of("no-existe")).toEqual([]);
    });

    it("el listado: la más nueva primero, paginado, con el total y sin los arreglos", async () => {
      const history = await harness();
      for (const id of ["m-a", "m-b", "m-c"]) {
        history.open(id, { ...SETUP, roomId: `room-${id}`, matchStartedAt: 1_000 });
        history.record([entry(1, { matchId: id })]);
        await history.drain();
        // `createdAt` es el instante real de la escritura: sin un milisegundo en el medio, el orden
        // lo decide el desempate y no lo que este test quiere medir.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      history.close("m-a", { ...CLOSING, roomId: "room-m-a" });
      await history.drain();

      const first = await history.page(1, 2);
      expect(first.total).toBe(3);
      expect(first.items.map((item) => item.matchId)).toEqual(["m-c", "m-b"]);
      const second = await history.page(2, 2);
      expect(second.items.map((item) => item.matchId)).toEqual(["m-a"]);
      expect(second.items[0]).toMatchObject({
        game: "domino",
        roomId: "room-m-a",
        status: "finished",
        table: SETUP.table,
        matchStartedAt: new Date(1_000),
        matchEndedAt: new Date(61_000),
        matchEndReason: "SCORE",
        winnerIds: ["seat-1"],
      });
      expect(typeof second.items[0]?._id).toBe("string");
      expect(second.items[0]?.createdAt).toBeInstanceOf(Date);
      expect(second.items[0]?.updatedAt).toBeInstanceOf(Date);
      for (const item of [...first.items, ...second.items]) {
        expect(item).not.toHaveProperty("timeline");
        expect(item).not.toHaveProperty("rounds");
        expect(item).not.toHaveProperty("seats");
      }
      expect((await history.page(3, 2)).items).toEqual([]);
    });
  });
}
