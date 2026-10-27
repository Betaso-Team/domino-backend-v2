import { describe, expect, it } from "vitest";
import type {
  ClosedRound,
  HistoryEntry,
  HistoryPort,
  HistoryReader,
  MatchArchive,
  MatchClosing,
  MatchListPage,
  MatchListQuery,
  MatchSetup,
} from "../../history";
import type { HistoryAdapterOptions } from "../stored-record";

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

// UN RELOJ QUE EL TEST MUEVE: `createdAt` es el instante de la escritura, y los empates en el mismo
// milisegundo —lo que el desempate por `_id` tiene que resolver— no se le pueden pedir a uno de verdad.
function testClock(start = T0) {
  let now = start;
  return {
    now: () => new Date(now),
    set: (epochMs: number) => {
      now = epochMs;
    },
  };
}

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (seconds: number) => T0 + seconds * 1_000;

interface Row {
  readonly matchId: string;
  readonly at: number;
  /** `null`: un documento sin sala, como los de antes de la v2.1 (nace por la timeline, sin abrir). */
  readonly roomId?: string | null;
  /** El `userId` de cada asiento, en orden; sin esto, los de `SETUP`. */
  readonly users?: readonly string[];
}

/** Los asientos de una mesa con estos usuarios, en orden: dos o cuatro. */
const seatsOf = (users: readonly string[]): MatchSetup["seats"] =>
  users.map((userId, seat) => ({
    id: `seat-${seat + 1}`,
    teamId: seat % 2 === 0 ? "A" : "B",
    seat,
    userId,
    displayName: userId,
    currency: "VES",
  }));

async function seed(
  history: HistoryHarness,
  clock: ReturnType<typeof testClock>,
  rows: readonly Row[],
): Promise<void> {
  for (const row of rows) {
    clock.set(row.at);
    if (row.roomId === null) history.record([entry(1, { matchId: row.matchId })]);
    else
      history.open(row.matchId, {
        ...SETUP,
        roomId: row.roomId ?? `room-${row.matchId}`,
        ...(row.users ? { seats: seatsOf(row.users) } : {}),
        matchStartedAt: 1_000,
      });
    await history.drain();
  }
}

/** Recorre el listado siguiendo el cursor, y devuelve cada página. */
async function walk(
  history: HistoryHarness,
  query: MatchListQuery,
): Promise<readonly MatchListPage[]> {
  const pages: MatchListPage[] = [];
  let after = query.after;
  do {
    const page = await history.list({ ...query, ...(after ? { after } : {}) });
    pages.push(page);
    after = page.next;
  } while (after && pages.length < 100);
  return pages;
}

const idsOf = (pages: readonly MatchListPage[]) =>
  pages.flatMap((page) => page.items.map((item) => item.matchId));

// EL ORDEN DEL LISTADO, calculado desde los documentos y no supuesto: `createdAt` descendente y, en el
// mismo milisegundo, el `_id` descendente.
async function expectedOrder(history: HistoryHarness, matchIds: readonly string[]) {
  const records = await Promise.all(matchIds.map((matchId) => history.recordOf(matchId)));
  return records
    .map((record) => ({
      matchId: String(record?.matchId),
      createdAt: (record?.createdAt as Date).getTime(),
      id: String(record?._id),
    }))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map(({ matchId }) => matchId);
}

export function describeHistoryContract(
  name: string,
  harness: (options?: HistoryAdapterOptions) => Promise<HistoryHarness> | HistoryHarness,
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

    it("al cerrar: la conexión de cada asiento, con los instantes de sus hechos como fechas", async () => {
      const history = await harness();
      const verdict = {
        blame: "NETWORK",
        cause: "CONNECTION_LOST",
        verdictVersion: 1,
      } as const;
      const server = {
        eventLoopP99Ms: 12,
        othersWithHighRtt: 0,
        othersConnected: 1,
        shuttingDown: false,
      };
      const rtt = { samples: 3, avgMs: 85, maxMs: 90, jitterMs: 4, lostProbes: 0 };
      const [first, second] = CLOSING.players;
      history.close("m-1", {
        ...CLOSING,
        players: [
          {
            ...(first as MatchClosing["players"][number]),
            connection: {
              rtt,
              events: [
                {
                  kind: "DROPPED",
                  at: 20_000,
                  roundNumber: 1,
                  closeCode: 1006,
                  sinceLastPongMs: 4_000,
                  recentRttMs: [80, null, 90],
                  server,
                  verdict,
                },
                { kind: "RECONNECTED", at: 25_000, roundNumber: 1, awayMs: 5_000 },
              ],
            },
          },
          second as MatchClosing["players"][number],
        ],
      });
      await history.drain();

      const record = await history.recordOf("m-1");
      expect(record).toMatchObject({
        players: [
          {
            connection: {
              rtt,
              events: [
                {
                  kind: "DROPPED",
                  at: new Date(20_000),
                  recentRttMs: [80, null, 90],
                  server,
                  verdict,
                },
                { kind: "RECONNECTED", at: new Date(25_000), awayMs: 5_000 },
              ],
            },
          },
          {},
        ],
      });
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
      expect((await history.list({ pageSize: 25 })).items).toHaveLength(1);
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
      expect((await history.list({ pageSize: 25 })).items).toHaveLength(1);
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

    it("el listado: la más nueva primero, el resumen sin los arreglos", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      await seed(history, clock, [
        { matchId: "m-a", at: at(1) },
        { matchId: "m-b", at: at(2) },
        { matchId: "m-c", at: at(3) },
      ]);
      history.record([entry(1, { matchId: "m-a" })]);
      history.round("m-a", ROUND);
      history.close("m-a", { ...CLOSING, roomId: "room-m-a" });
      await history.drain();

      const first = await history.list({ pageSize: 2 });
      expect(first.items.map((item) => item.matchId)).toEqual(["m-c", "m-b"]);
      const second = await history.list({
        pageSize: 2,
        ...(first.next ? { after: first.next } : {}),
      });
      expect(second.items.map((item) => item.matchId)).toEqual(["m-a"]);
      expect(second.next).toBeUndefined();
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
      expect(second.items[0]?.createdAt).toEqual(new Date(at(1)));
      expect(second.items[0]?.updatedAt).toBeInstanceOf(Date);
      // UN RESUMEN: nada de lo grande ni de lo que sólo el detalle muestra.
      for (const item of [...first.items, ...second.items]) {
        for (const field of ["timeline", "rounds", "seats", "players", "matchConfig", "entries"])
          expect(item).not.toHaveProperty(field);
      }
    });

    // EL CURSOR, con empates: cuatro partidas en el MISMO milisegundo y páginas que las parten. Sin el
    // `_id` de desempate —o con un `<=` donde va un `<`— una página repetiría o perdería una fila.
    it("el cursor recorre todo sin repetir ni saltear, con empates en el mismo milisegundo", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      const rows: Row[] = [
        { matchId: "m-1", at: at(1) },
        { matchId: "m-2", at: at(2) },
        { matchId: "m-3", at: at(2) },
        { matchId: "m-4", at: at(2) },
        { matchId: "m-5", at: at(2) },
        { matchId: "m-6", at: at(3) },
        { matchId: "m-7", at: at(4) },
      ];
      await seed(history, clock, rows);
      const expected = await expectedOrder(
        history,
        rows.map((row) => row.matchId),
      );
      expect(expected.slice(0, 2)).toEqual(["m-7", "m-6"]);
      expect(expected.at(-1)).toBe("m-1");

      for (const pageSize of [1, 2, 3, 7, 10]) {
        const pages = await walk(history, { pageSize });
        expect(idsOf(pages), `pageSize ${pageSize}`).toEqual(expected);
        expect(pages.every((page) => page.items.length <= pageSize)).toBe(true);
        // LA ÚLTIMA NO PROMETE OTRA: se pide una fila de más para saberlo, también cuando la última
        // página viene llena.
        expect(pages.at(-1)?.next).toBeUndefined();
        expect(pages.length).toBe(Math.max(1, Math.ceil(expected.length / pageSize)));
      }
    });

    it("cada filtro solo, y combinados con AND", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      await seed(history, clock, [
        { matchId: "m-1", at: at(10), roomId: "sala-x" },
        { matchId: "m-2", at: at(20), roomId: "sala-y" },
        { matchId: "m-3", at: at(30), roomId: "sala-x" },
        { matchId: "m-4", at: at(40), roomId: "sala-z" },
        { matchId: "m-vieja", at: at(25), roomId: null },
      ]);
      const ids = async (query: Omit<MatchListQuery, "pageSize">) =>
        idsOf(await walk(history, { pageSize: 2, ...query }));
      const record = await history.recordOf("m-2");

      // EL DOCUMENTO SIN SALA —la forma vieja— se lista igual; sólo el filtro por sala lo deja afuera.
      expect(await ids({})).toEqual(["m-4", "m-3", "m-vieja", "m-2", "m-1"]);
      expect(await ids({ matchId: "m-3" })).toEqual(["m-3"]);
      expect(await ids({ matchId: "no-existe" })).toEqual([]);
      expect(await ids({ roomId: "sala-x" })).toEqual(["m-3", "m-1"]);
      expect(await ids({ id: String(record?._id) })).toEqual(["m-2"]);
      expect(await ids({ id: "0".repeat(24) })).toEqual([]);
      // `from` INCLUSIVO y `to` EXCLUSIVO: [20 s, 30 s) tiene la de los 20 y no la de los 30.
      expect(await ids({ from: new Date(at(20)), to: new Date(at(30)) })).toEqual([
        "m-vieja",
        "m-2",
      ]);
      expect(await ids({ from: new Date(at(30)) })).toEqual(["m-4", "m-3"]);
      expect(await ids({ to: new Date(at(20)) })).toEqual(["m-1"]);
      expect(await ids({ from: new Date(at(20)), to: new Date(at(20)) })).toEqual([]);
      // AND: la sala Y las fechas; la partida Y la sala; el `_id` Y una sala que no es la suya.
      expect(await ids({ roomId: "sala-x", from: new Date(at(20)) })).toEqual(["m-3"]);
      expect(await ids({ roomId: "sala-x", to: new Date(at(30)) })).toEqual(["m-1"]);
      expect(await ids({ matchId: "m-3", roomId: "sala-x" })).toEqual(["m-3"]);
      expect(await ids({ matchId: "m-3", roomId: "sala-y" })).toEqual([]);
      expect(await ids({ matchId: "m-3", from: new Date(at(31)) })).toEqual([]);
      expect(await ids({ id: String(record?._id), roomId: "sala-x" })).toEqual([]);
      expect(
        await ids({ id: String(record?._id), matchId: "m-2", from: new Date(at(20)) }),
      ).toEqual(["m-2"]);
    });

    it("el cursor sigue los filtros: la sala y las fechas, en páginas de a una", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      await seed(history, clock, [
        { matchId: "m-1", at: at(1), roomId: "sala-x" },
        { matchId: "m-2", at: at(2), roomId: "sala-x" },
        { matchId: "m-3", at: at(2), roomId: "sala-x" },
        { matchId: "m-4", at: at(2), roomId: "sala-y" },
        { matchId: "m-5", at: at(3), roomId: "sala-x" },
        { matchId: "m-6", at: at(9), roomId: "sala-x" },
      ]);
      // La de los 9 s queda afuera por el `to` exclusivo; la de otra sala, por la sala.
      const expected = await expectedOrder(history, ["m-1", "m-2", "m-3", "m-5"]);

      const pages = await walk(history, {
        pageSize: 1,
        roomId: "sala-x",
        from: new Date(at(1)),
        to: new Date(at(9)),
      });
      expect(idsOf(pages)).toEqual(expected);
      expect(pages).toHaveLength(4);
    });

    it("el total: estimado sin filtros, exacto con filtros, `null` con cursor", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      await seed(history, clock, [
        { matchId: "m-1", at: at(1), roomId: "sala-x" },
        { matchId: "m-2", at: at(2), roomId: "sala-x" },
        { matchId: "m-3", at: at(3) },
      ]);

      const all = await history.list({ pageSize: 2 });
      expect({ total: all.total, totalExact: all.totalExact }).toEqual({
        total: 3,
        totalExact: false,
      });
      const room = await history.list({ pageSize: 1, roomId: "sala-x" });
      expect({ total: room.total, totalExact: room.totalExact }).toEqual({
        total: 2,
        totalExact: true,
      });
      const none = await history.list({ pageSize: 1, matchId: "no-existe" });
      expect({ total: none.total, totalExact: none.totalExact }).toEqual({
        total: 0,
        totalExact: true,
      });
      // CON CURSOR NO SE CUENTA, con o sin filtros: la primera página ya lo dijo.
      for (const query of [{}, { roomId: "sala-x" }]) {
        const first = await history.list({ pageSize: 1, ...query });
        const next = await history.list({
          pageSize: 1,
          ...query,
          ...(first.next ? { after: first.next } : {}),
        });
        expect(next.items).toHaveLength(1);
        expect({ total: next.total, totalExact: next.totalExact }).toEqual({
          total: null,
          totalExact: false,
        });
      }
    });

    // EL TOPE, con uno chico inyectado: contar más allá cuesta lo mismo que la colección entera.
    it("el total filtrado se corta en el tope y deja de ser exacto", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now, countCap: 3 });
      await seed(
        history,
        clock,
        ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7"].map((matchId, index) => ({
          matchId,
          at: at(index + 1),
          roomId: index < 3 ? "sala-tres" : "sala-cuatro",
        })),
      );

      const capped = await history.list({ pageSize: 10, roomId: "sala-cuatro" });
      expect(capped.items).toHaveLength(4);
      expect({ total: capped.total, totalExact: capped.totalExact }).toEqual({
        total: 3,
        totalExact: false,
      });
      // JUSTO EN EL TOPE todavía es exacto: se cuenta hasta el tope más uno para distinguirlo.
      const exact = await history.list({ pageSize: 10, roomId: "sala-tres" });
      expect({ total: exact.total, totalExact: exact.totalExact }).toEqual({
        total: 3,
        totalExact: true,
      });
    });

    // EL JUGADOR, por la identidad de cualquiera de sus ASIENTOS (`seats[].userId`): en la mesa de cuatro
    // el que busca puede estar en el cuarto. Un documento de la forma vieja no tiene asientos y no
    // coincide nunca; el que nace en el cierre —la mesa que no arrancó— sí los tiene.
    it("por jugador: cualquier asiento, con fechas, y la forma vieja nunca", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      await seed(history, clock, [
        { matchId: "m-1", at: at(10), users: ["ana", "beto"] },
        { matchId: "m-2", at: at(20), users: ["carla", "dani", "eva", "ana"] },
        { matchId: "m-3", at: at(30), users: ["beto", "carla"] },
        { matchId: "m-vieja", at: at(40), roomId: null },
        { matchId: "m-5", at: at(50), users: ["beto", "ana"] },
      ]);
      clock.set(at(60));
      const { matchStartedAt, matchDurationInMs, ...neverStarted } = CLOSING;
      history.close("m-6", {
        ...neverStarted,
        seats: seatsOf(["fede", "ana"]),
        status: "aborted",
        matchEndReason: "NEVER_STARTED",
      });
      await history.drain();
      const ids = async (query: Omit<MatchListQuery, "pageSize">) =>
        idsOf(await walk(history, { pageSize: 2, ...query }));

      expect(await ids({ userId: "ana" })).toEqual(["m-6", "m-5", "m-2", "m-1"]);
      expect(await ids({ userId: "eva" })).toEqual(["m-2"]);
      expect(await ids({ userId: "beto", from: new Date(at(20)), to: new Date(at(50)) })).toEqual([
        "m-3",
      ]);
      expect(await ids({ userId: "ana", roomId: "room-m-2" })).toEqual(["m-2"]);
      expect(await ids({ userId: "beto", matchId: "m-2" })).toEqual([]);
      // EXACTO: ni prefijo, ni mayúsculas, ni el `id` del asiento.
      for (const userId of ["an", "ANA", "seat-1", "u1"]) expect(await ids({ userId })).toEqual([]);
      // La forma vieja tiene `entries` con un `playerId`, no asientos: no coincide con nada.
      expect(await ids({ userId: "seat-1" })).toEqual([]);

      const page = await history.list({ pageSize: 10, userId: "ana" });
      expect({ total: page.total, totalExact: page.totalExact }).toEqual({
        total: 4,
        totalExact: true,
      });
    });

    // EL MISMO USUARIO EN DOS ASIENTOS (bots, pruebas): un índice multikey tiene una clave por elemento,
    // y una partida no puede salir dos veces ni contar doble. Con el cursor y empates en el mismo
    // milisegundo, el recorrido entero no repite ni saltea.
    it("por jugador con cursor: sin repetir aunque esté en dos asientos, y con empates", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now, countCap: 4 });
      await seed(history, clock, [
        { matchId: "m-1", at: at(1), users: ["bot", "bot"] },
        { matchId: "m-2", at: at(2), users: ["ana", "bot", "bot", "beto"] },
        { matchId: "m-3", at: at(2), users: ["bot", "ana"] },
        { matchId: "m-4", at: at(2), users: ["beto", "carla"] },
        { matchId: "m-5", at: at(2), users: ["bot", "bot", "bot", "bot"] },
        { matchId: "m-6", at: at(3), users: ["carla", "bot"] },
        { matchId: "m-7", at: at(4), users: ["bot", "dani"] },
      ]);
      const expected = await expectedOrder(history, ["m-1", "m-2", "m-3", "m-5", "m-6", "m-7"]);

      for (const pageSize of [1, 2, 4, 6]) {
        const pages = await walk(history, { pageSize, userId: "bot" });
        expect(idsOf(pages), `pageSize ${pageSize}`).toEqual(expected);
        expect(pages.at(-1)?.next).toBeUndefined();
      }
      const fromTwo = await walk(history, { pageSize: 1, userId: "bot", from: new Date(at(2)) });
      expect(idsOf(fromTwo)).toEqual(expected.slice(0, 5));
      // SEIS PARTIDAS, no once claves: sobre el tope de cuatro, cortado y no exacto.
      const capped = await history.list({ pageSize: 10, userId: "bot" });
      expect(capped.items).toHaveLength(6);
      expect({ total: capped.total, totalExact: capped.totalExact }).toEqual({
        total: 4,
        totalExact: false,
      });
      const exact = await history.list({ pageSize: 10, userId: "bot", from: new Date(at(3)) });
      expect({ total: exact.total, totalExact: exact.totalExact }).toEqual({
        total: 2,
        totalExact: true,
      });
    });

    // EL MOTIVO DEL CIERRE (`matchEndReason`), exacto. Lo escribe el cierre, así que una partida todavía
    // abierta no tiene motivo y no coincide con ninguno, y la forma vieja tampoco: nunca lo grabó.
    it("por motivo del cierre: exacto, con los demás filtros, y la abierta nunca", async () => {
      const clock = testClock();
      const history = await harness({ now: clock.now });
      const rows: readonly Row[] = [
        { matchId: "m-1", at: at(10), users: ["ana", "beto"] },
        { matchId: "m-2", at: at(20), users: ["ana", "carla"] },
        { matchId: "m-3", at: at(30), users: ["beto", "carla"] },
        { matchId: "m-abierta", at: at(40), users: ["ana", "dani"] },
        { matchId: "m-vieja", at: at(50), roomId: null },
        { matchId: "m-6", at: at(60), users: ["ana", "eva"] },
      ];
      await seed(history, clock, rows);
      clock.set(at(70));
      const closings: [string, MatchClosing["matchEndReason"], MatchClosing["status"]][] = [
        ["m-1", "SCORE", "finished"],
        ["m-2", "ABANDONMENT", "finished"],
        ["m-3", "ABANDONMENT", "finished"],
        ["m-6", "CHARGE_REJECTED", "aborted"],
      ];
      for (const [matchId, matchEndReason, status] of closings) {
        const users = rows.find((row) => row.matchId === matchId)?.users ?? [];
        history.close(matchId, {
          ...CLOSING,
          roomId: `room-${matchId}`,
          seats: seatsOf(users),
          status,
          matchEndReason,
        });
      }
      await history.drain();
      const ids = async (query: Omit<MatchListQuery, "pageSize">) =>
        idsOf(await walk(history, { pageSize: 1, ...query }));

      expect(await ids({ matchEndReason: "SCORE" })).toEqual(["m-1"]);
      expect(await ids({ matchEndReason: "ABANDONMENT" })).toEqual(["m-3", "m-2"]);
      expect(await ids({ matchEndReason: "CHARGE_REJECTED" })).toEqual(["m-6"]);
      expect(await ids({ matchEndReason: "NEVER_STARTED" })).toEqual([]);
      // CON LOS DEMÁS, por AND: el jugador, las fechas y la sala.
      expect(await ids({ matchEndReason: "ABANDONMENT", userId: "ana" })).toEqual(["m-2"]);
      expect(await ids({ matchEndReason: "ABANDONMENT", from: new Date(at(25)) })).toEqual(["m-3"]);
      expect(await ids({ matchEndReason: "SCORE", roomId: "room-m-2" })).toEqual([]);

      const page = await history.list({ pageSize: 10, matchEndReason: "ABANDONMENT" });
      expect({ total: page.total, totalExact: page.totalExact }).toEqual({
        total: 2,
        totalExact: true,
      });
    });
  });
}
