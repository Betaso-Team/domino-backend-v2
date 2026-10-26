import { Mongo } from "@/shared/mongo";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import type { Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MATCH_COUNT_CAP, type MatchCursor, type MatchListQuery } from "../history";
import {
  HISTORY_COLLECTION,
  LIST_MAX_TIME_MS,
  MongoHistory,
  countQueryOf,
  pageQueryOf,
  playerPageQueryOf,
} from "./mongo-history";
import type { HistoryAdapterOptions } from "./stored-record";
import { SETUP, describeHistoryContract, entry } from "./tests/history-contract";
import { describePlayerLogContract } from "./tests/player-log-contract";

// EL CONTRATO CONTRA UN MONGO DE VERDAD, y es el único lugar donde se puede medir: la cabecera y el
// cierre van por pipeline (`$replaceWith`), y lo que hay que ver —que el primero gane, que lo cerrado
// no se reabra, que los arreglos queden al final, que un campo ausente no nazca vacío— es semántica
// de la base, que un doble del driver repetiría en vez de medir.
//
// ⚠ PIDE UN MONGO DE VERDAD: lee `MONGO_INT_URI` y se saltea sin ella (`src/tests/int-services.ts`).
// La colección no es configurable (`HISTORY_COLLECTION`), así que el aislamiento es la BASE de la URI:
// apuntala a una base de prueba, nunca a la de una instancia.
let mongo: Mongo;

const collection = () => mongo.collection(HISTORY_COLLECTION);

async function fresh(
  logger = new MemoryLogger(),
  options: HistoryAdapterOptions = {},
): Promise<MongoHistory> {
  await (await collection()).deleteMany({});
  return new MongoHistory(mongo, logger, options);
}

describe.skipIf(!MONGO_INT_URI)("MongoHistory contra Mongo", () => {
  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  afterAll(async () => {
    await (await collection()).drop().catch(() => {});
    await mongo.close();
  });

  describeHistoryContract("MongoHistory", (options) => fresh(undefined, options));
  describePlayerLogContract("MongoHistory", (options) => fresh(undefined, options));

  it("crea sus cuatro índices, con el de `matchId` único", async () => {
    const history = await fresh();
    history.record([entry(1)]);
    await history.drain();

    const indexes = await (await collection()).indexes();
    expect(indexes.map(({ name }) => name).sort()).toEqual([
      "_id_",
      "createdAt_-1__id_-1",
      "matchId_1",
      "roomId_1_createdAt_-1__id_-1",
      "seats.userId_1_createdAt_-1__id_-1",
    ]);
    expect(indexes.find(({ name }) => name === "matchId_1")?.unique).toBe(true);
    // EL DOCUMENTO NO PUEDE NACER DOS VECES, ni siquiera por fuera de la cola de este proceso.
    await expect((await collection()).insertOne({ matchId: "m-1" })).rejects.toThrow(/duplicate/);
  });

  // EL ORDEN FÍSICO, leído crudo y no por `recordOf` —que reordena al leer—: una lectura truncada de
  // la base pierde el final del documento, y el final tiene que ser lo grande. La timeline nace antes
  // que la cabecera cuando alguien se cae durante el sentado, y aun así queda al final.
  it("la cabecera y el cierre dejan los arreglos al final del documento guardado", async () => {
    const history = await fresh();
    history.record([entry(1, { type: "PLAYER_DISCONNECTED", kind: "EVENT", source: "SYSTEM" })]);
    history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
    const opened = async () => Object.keys((await (await collection()).findOne({})) ?? {});
    await history.drain();
    expect((await opened()).at(-1)).toBe("timeline");
    expect((await opened())[0]).toBe("_id");

    history.round("m-1", {
      roundNumber: 1,
      endReason: "DOMINO",
      starterId: "seat-1",
      hands: [],
    });
    history.close("m-1", {
      ...SETUP,
      status: "aborted",
      matchEndedAt: 2_000,
      matchEndReason: "INTERRUPTED",
      winnerIds: [],
      players: [],
      rateId: "r",
      betMultiplier: { offeredValues: [], finalValue: 1, proposals: [] },
      rankingMultiplier: { base: 1, extra: 0, final: 1 },
    });
    await history.drain();
    expect((await opened()).slice(-2)).toEqual(["rounds", "timeline"]);
  });

  // LA FORMA VIEJA —`{ matchId, entries, createdAt, updatedAt }`, con el `at` como número— se sigue
  // leyendo en los tres lectores: la secuencia, el detalle y el listado.
  it("un documento de antes de la v2.1 se lee igual", async () => {
    const history = await fresh();
    const createdAt = new Date("2026-10-01T10:00:00.000Z");
    await (await collection()).insertOne({
      matchId: "m-vieja",
      entries: [entry(2, { matchId: "m-vieja" }), entry(1, { matchId: "m-vieja" })],
      createdAt,
      updatedAt: createdAt,
    });

    expect((await history.of("m-vieja")).map(({ seq, at }) => [seq, at])).toEqual([
      [2, 1_700_000_000_002],
      [1, 1_700_000_000_001],
    ]);
    const record = await history.recordOf("m-vieja");
    expect(record).toMatchObject({ matchId: "m-vieja", createdAt });
    expect(typeof record?._id).toBe("string");
    expect(record?.entries).toHaveLength(2);
    expect(await history.snapshotOf("m-vieja")).toMatchObject({ matchId: "m-vieja" });
    const { items } = await history.list({ pageSize: 25 });
    expect(items).toEqual([
      { _id: record?._id, matchId: "m-vieja", game: "domino", createdAt, updatedAt: createdAt },
    ]);
  });

  // UN ÍNDICE QUE NO SE PUEDE CREAR NO FRENA EL HISTORIAL: dos filas viejas de la misma partida hacen
  // fallar el único, y el resto de las partidas tiene que seguir grabándose.
  it("si el índice único no se puede crear, lo dice y graba igual", async () => {
    await (await collection()).drop().catch(() => {});
    await (await collection()).insertMany([{ matchId: "dup" }, { matchId: "dup" }]);
    const logger = new MemoryLogger();
    const history = new MongoHistory(mongo, logger);

    history.open("m-nueva", { ...SETUP, matchStartedAt: 1_000 });
    await history.drain();

    expect(await history.recordOf("m-nueva")).toMatchObject({ status: "started" });
    expect(logger.at_("error").map(({ msg }) => msg)).toEqual([
      "historial: no se pudieron crear los índices; se graba igual",
    ]);
    // LOS DEL LISTADO SE CREAN IGUAL: sin ellos el panel recorrería la colección entera.
    expect((await (await collection()).indexes()).map(({ name }) => name).sort()).toEqual([
      "_id_",
      "createdAt_-1__id_-1",
      "roomId_1_createdAt_-1__id_-1",
      "seats.userId_1_createdAt_-1__id_-1",
    ]);
    await (await collection()).drop();
  });

  // ── LA PRUEBA DE LOS ÍNDICES ─────────────────────────────────────────────────────────────────
  //
  // LA COLECCIÓN DE PRODUCCIÓN TIENE MILLONES DE DOCUMENTOS, y el listado tiene que contestar en
  // milisegundos con cualquier combinación de filtros y en cualquier página. Eso no lo dice el tiempo de
  // una suite con trescientos documentos; lo dice el PLAN: sin COLLSCAN (recorrer la colección), sin
  // SORT (ordenar en memoria lo que el índice no trae ordenado) y leyendo como mucho las filas que la
  // página devuelve. Se mide `explain("executionStats")` sobre LA MISMA consulta que corre el adaptador
  // (`pageQueryOf`), no sobre una copia, con documentos suficientes para que un recorrido se note.
  describe("cada forma del listado sale de un índice", () => {
    const PAGE = 20;
    const T = Date.parse("2026-09-01T00:00:00.000Z");
    let history: MongoHistory;
    let some: { _id: unknown; matchId: string; roomId: string };

    // Lo que el plan ganador hace, aplanado: el nombre de cada etapa, con su índice. El árbol cambia de
    // forma según el motor (`inputStage`, `inputStages`, `queryPlan`), así que se recorre entero.
    const stagesOf = (plan: unknown, found: string[] = []): string[] => {
      if (plan && typeof plan === "object") {
        const node = plan as Record<string, unknown>;
        if (typeof node.stage === "string") found.push(node.stage);
        for (const child of Object.values(node)) stagesOf(child, found);
      }
      return found;
    };

    async function explained(query: MatchListQuery) {
      const { filter, options } = pageQueryOf(query);
      const explain = (await (
        await collection()
      )
        .find(filter as Document, options)
        .explain("executionStats")) as Document;
      return {
        stages: stagesOf(explain.queryPlanner.winningPlan),
        docsExamined: explain.executionStats.totalDocsExamined as number,
        returned: explain.executionStats.nReturned as number,
      };
    }

    beforeAll(async () => {
      history = await fresh();
      // Los índices se piden con el primer uso, como en producción.
      await history.list({ pageSize: 1 });
      // TRESCIENTAS PARTIDAS en quince salas, de a tres por segundo —empates en el mismo milisegundo—,
      // con su timeline y cuatro asientos: tres jugadores de diez, y en el cuarto `jugador-x` (que está
      // en cuatro de cada cinco) o, cada cinco, el del primero repetido —el mismo usuario en dos
      // asientos, dos claves del índice multikey para un documento—. Más veinte de la forma vieja, sin
      // sala ni asientos.
      await (await collection()).insertMany([
        ...Array.from({ length: 300 }, (_, index) => ({
          matchId: `p-${index}`,
          roomId: `sala-${index % 15}`,
          version: 2.1,
          status: "finished",
          createdAt: new Date(T + Math.floor(index / 3) * 1_000),
          updatedAt: new Date(T + Math.floor(index / 3) * 1_000),
          seats: [
            `jugador-${index % 10}`,
            `jugador-${(index + 3) % 10}`,
            `jugador-${(index + 6) % 10}`,
            index % 5 === 0 ? `jugador-${index % 10}` : "jugador-x",
          ].map((userId, seat) => ({ id: `seat-${seat + 1}`, seat, userId })),
          timeline: [entry(1, { matchId: `p-${index}` })],
        })),
        ...Array.from({ length: 20 }, (_, index) => ({
          matchId: `vieja-${index}`,
          entries: [entry(1, { matchId: `vieja-${index}` })],
          createdAt: new Date(T + index * 5_000 + 500),
          updatedAt: new Date(T + index * 5_000 + 500),
        })),
      ]);
      some = (await (await collection()).findOne({ matchId: "p-150" })) as unknown as typeof some;
    });

    const from = new Date(T + 20_000);
    const to = new Date(T + 80_000);
    const shapes: [string, () => MatchListQuery][] = [
      ["sin filtros", () => ({ pageSize: PAGE })],
      ["fechas", () => ({ pageSize: PAGE, from, to })],
      ["solo desde", () => ({ pageSize: PAGE, from })],
      ["matchId", () => ({ pageSize: PAGE, matchId: some.matchId })],
      ["roomId", () => ({ pageSize: PAGE, roomId: some.roomId })],
      ["id", () => ({ pageSize: PAGE, id: String(some._id) })],
      ["fechas + roomId", () => ({ pageSize: PAGE, from, to, roomId: some.roomId })],
      ["fechas + matchId", () => ({ pageSize: PAGE, from, to, matchId: some.matchId })],
      ["userId (dos asientos en un tercio)", () => ({ pageSize: PAGE, userId: "jugador-5" })],
      ["userId del cuarto asiento", () => ({ pageSize: PAGE, userId: "jugador-x" })],
      ["fechas + userId", () => ({ pageSize: PAGE, from, to, userId: "jugador-5" })],
      [
        "fechas + roomId + userId",
        () => ({ pageSize: PAGE, from, roomId: "sala-5", userId: "jugador-5" }),
      ],
      [
        "matchId + roomId + id",
        () => ({
          pageSize: PAGE,
          matchId: some.matchId,
          roomId: some.roomId,
          id: String(some._id),
        }),
      ],
    ];

    // EL HISTORIAL DEL JUGADOR USA EL ÍNDICE DEL FILTRO POR JUGADOR: ordenado por el índice y leyendo
    // sólo lo que salta y lo que devuelve. Con `skip`, lo salteado se lee: la tercera página de diez lee
    // treinta, que sobre las partidas de una cuenta es lo aceptado (`playerPageQueryOf`).
    it.each([
      ["primera página", 1],
      ["tercera página", 3],
    ])("historial del jugador, %s: sin COLLSCAN ni SORT", async (_name, page) => {
      const perPage = 10;
      const { filter, options } = playerPageQueryOf("jugador-5", page, perPage);
      const explain = (await (
        await collection()
      )
        .find(filter as Document, options)
        .explain("executionStats")) as Document;
      const stages = stagesOf(explain.queryPlanner.winningPlan);

      expect(stages).not.toContain("COLLSCAN");
      expect(stages).not.toContain("SORT");
      expect(stages).toContain("IXSCAN");
      expect(explain.executionStats.totalDocsExamined).toBeLessThanOrEqual(page * perPage);
      expect(explain.executionStats.nReturned).toBe(perPage);
    });

    it.each(shapes)("%s: sin COLLSCAN, sin SORT y sin leer de más", async (_name, query) => {
      const plan = await explained(query());

      expect(plan.stages).not.toContain("COLLSCAN");
      expect(plan.stages).not.toContain("SORT");
      expect(
        plan.stages.some((stage) => ["IXSCAN", "IDHACK", "EXPRESS_IXSCAN"].includes(stage)),
      ).toBe(true);
      expect(plan.docsExamined).toBeLessThanOrEqual(PAGE + 1);
      // UN PLAN BARATO DE UN FILTRO IGNORADO también sería barato: la página tiene que ser la del
      // jugador, cada partida una vez.
      const { userId } = query();
      if (userId !== undefined) {
        const { items } = await history.list(query());
        expect(items.length).toBeGreaterThan(0);
        expect(new Set(items.map((item) => item._id)).size).toBe(items.length);
        const seated = await (await collection()).countDocuments({
          matchId: { $in: items.map((item) => item.matchId) },
          "seats.userId": userId,
        });
        expect(seated).toBe(items.length);
      }
    });

    // CON CURSOR, Y HONDO: la página sexta lee lo mismo que la segunda. Un `skip` leería las cien
    // anteriores para tirarlas; acá el cursor cae en medio de un empate de tres y aun así no lee de más.
    it.each([
      ["cursor, segunda página", {}, 1, PAGE],
      ["cursor, sexta página", {}, 5, PAGE],
      ["cursor + fechas", { from, to }, 2, PAGE],
      ["cursor + roomId", { roomId: "sala-3" }, 1, 4],
      ["cursor + fechas + roomId", { from: new Date(T), to, roomId: "sala-3" }, 1, 4],
      ["cursor + userId", { userId: "jugador-5" }, 2, PAGE],
      ["cursor + fechas + userId", { from: new Date(T), to, userId: "jugador-x" }, 2, PAGE],
    ] as const)(
      "%s: sin COLLSCAN, sin SORT y sin leer de más",
      async (_name, filters, depth, pageSize) => {
        let after: MatchCursor | undefined;
        for (let index = 0; index < depth; index += 1) {
          after = (await history.list({ pageSize, ...filters, ...(after ? { after } : {}) })).next;
        }
        expect(after).toBeDefined();
        const plan = await explained({ pageSize, ...filters, ...(after ? { after } : {}) });

        expect(plan.stages).not.toContain("COLLSCAN");
        expect(plan.stages).not.toContain("SORT");
        expect(plan.returned).toBe(pageSize + 1);
        expect(plan.docsExamined).toBeLessThanOrEqual(pageSize + 1);
        if ("userId" in filters) {
          const { items } = await history.list({
            pageSize,
            ...filters,
            ...(after ? { after } : {}),
          });
          const seated = await (await collection()).countDocuments({
            matchId: { $in: items.map((item) => item.matchId) },
            "seats.userId": filters.userId,
          });
          expect(seated).toBe(items.length);
        }
      },
    );

    // EL MISMO USUARIO EN DOS ASIENTOS, contra la base: el índice multikey tiene una clave por asiento, y
    // la partida tiene que salir una vez en el recorrido y contar una vez en el total.
    it("un jugador en dos asientos sale una vez: el recorrido entero y el total", async () => {
      const twice = await (await collection()).countDocuments({
        $expr: {
          $eq: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ["$seats", []] },
                  cond: { $eq: ["$$this.userId", "jugador-5"] },
                },
              },
            },
            2,
          ],
        },
      });
      expect(twice).toBe(30);
      const seated = await (await collection()).countDocuments({ "seats.userId": "jugador-5" });

      const seen: string[] = [];
      let after: MatchCursor | undefined;
      do {
        const page = await history.list({
          pageSize: 7,
          userId: "jugador-5",
          ...(after ? { after } : {}),
        });
        seen.push(...page.items.map((item) => item._id));
        after = page.next;
      } while (after);

      expect(seen).toHaveLength(seated);
      expect(new Set(seen).size).toBe(seated);
      expect((await history.list({ pageSize: 1, userId: "jugador-5" })).total).toBe(seated);
    });

    // EL TOTAL FILTRADO, la otra consulta del listado: `countDocuments` es un `$match` + `$limit` +
    // `$group` (así lo arma el driver), y se mide ese pipeline con los mismos filtros y el mismo tope.
    it.each(shapes.slice(1))("el total de %s: sin COLLSCAN", async (_name, query) => {
      const { filter, options } = countQueryOf(query(), MATCH_COUNT_CAP + 1);
      const explain = (await (
        await collection()
      )
        .aggregate([
          { $match: filter },
          { $limit: options.limit as number },
          { $group: { _id: 1, n: { $sum: 1 } } },
        ])
        .explain("executionStats")) as Document;

      expect(stagesOf(explain)).not.toContain("COLLSCAN");
    });

    it("el plazo viaja en cada consulta", () => {
      expect(pageQueryOf({ pageSize: PAGE }).options.maxTimeMS).toBe(LIST_MAX_TIME_MS);
      expect(countQueryOf({ pageSize: PAGE, from }, 10).options.maxTimeMS).toBe(LIST_MAX_TIME_MS);
    });
  });
});
