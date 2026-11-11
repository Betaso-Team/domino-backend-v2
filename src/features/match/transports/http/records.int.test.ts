import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@/logger";
import type { Admin, AdminTokenCheck } from "@/shared/http/api-key";
import { httpErrorHandler } from "@/shared/http/error-handler";
import { findBadAmounts } from "@/shared/tests/find-bad-amounts";
import { routesOf } from "@/tests/routes";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HistoryReader,
  type MatchArchive,
  type MatchListPage,
  type MatchListQuery,
  MatchListTimeoutError,
  type MatchSetup,
} from "../../network/history";
import { MemoryHistory } from "../../network/transports/memory-history";
import { CLOSING, SETUP, entry } from "../../network/transports/tests/history-contract";
import { recordRoutes } from "./records";

// Las llaves que llevan plata en el registro que leen el panel y el backend principal.
const RECORD_MONEY_KEYS = [
  "entryFee",
  "prize",
  "entry",
  "charged",
  "prizePaid",
  "resultingEntryFee",
  "resultingPrize",
  "additionalEntryFee",
];
import { type MatchHttpDeps, matchHttp } from "./register";

const KEY = "k".repeat(16);

function fakeLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

// UN ARCHIVO QUE NUNCA SE CONSULTA: lo que se mide en estos casos es el registro de las rutas, no su
// handler. Si alguno se llama, truena y el test lo dice.
const untouched: MatchArchive = {
  recordOf: () => Promise.reject(new Error("el registro de la ruta no debe leer el archivo")),
  snapshotOf: () => Promise.reject(new Error("el registro de la ruta no debe leer el archivo")),
  list: () => Promise.reject(new Error("el registro de la ruta no debe leer el archivo")),
  hasRecord: () => Promise.reject(new Error("el registro de la ruta no debe leer el archivo")),
};

interface ListBody {
  items: Record<string, unknown>[];
  pageSize: number;
  nextCursor: string | null;
  total: number | null;
  totalExact: boolean;
}

// UN CURSOR ARMADO A MANO, con la forma que la ruta emite: base64url de un JSON chico. Lo que se mide
// con él es que la ruta rechace lo que no es suyo, no la codificación —ésa la mide el recorrido—.
const cursorOf = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("recordRoutes: el registro de las rutas", () => {
  // FAIL CLOSED, como el historial: sin llave las rutas del panel no existen.
  it("sin llave interna no se registra ninguna, y el aviso las nombra", () => {
    const logger = fakeLogger();
    expect(routesOf(recordRoutes({ logger, archive: untouched, adminApiKey: undefined }))).toEqual(
      [],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /GET \/internal\/matches,.*GET \/internal\/matches\/:matchId.*GET \/game-data\/:roomId/,
      ),
    );
  });

  // EL ORDEN DEL ROUTER ENTERO DE LA PARTIDA: el historial antes que el detalle, y el `GET` del panel
  // y el `POST` del orquestador sobre el mismo path, cada uno en su lugar. Se lee del `stack` porque
  // dos órdenes distintos contestan igual HOY y dejan de hacerlo con la ruta que se agregue mañana.
  it("en el router de la partida, el historial va antes que el detalle", () => {
    const deps = {
      logger: fakeLogger(),
      history: { of: () => Promise.resolve([]) } satisfies HistoryReader,
      archive: untouched,
      adminApiKey: KEY,
      orchestratorApiKey: KEY,
    } as unknown as MatchHttpDeps;

    const routes = routesOf(matchHttp(deps));

    expect(routes).toEqual([
      "GET /internal/matches/:matchId/history",
      "GET /internal/matches",
      "GET /internal/matches/:matchId",
      "GET /game-data/:roomId",
      "GET /internal/players/:userId/matches",
      "POST /internal/matches",
      "POST /internal/players/:userId/seat",
      "GET /internal/players/:userId/match",
      // Dos segmentos tras `matches`: ni el detalle (uno) ni el historial (otro literal) la tapan.
      "GET /internal/matches/:matchId/existence",
      "GET /internal/census",
    ]);
  });
});

// Un Express DE VERDAD sobre un puerto efímero, con el mismo parser y el mismo manejador de errores que
// `app.config.ts`: lo que se mide son status y cuerpos, y eso lo decide Express.
const servers: Server[] = [];

// LOS ADMINS CON SESIÓN, sin firmar nada: el token ES la clave de este mapa. Lo que se mide acá es el
// ámbito de la ruta; la verificación del token la mide su propia suite.
const ADMINS: Record<string, Admin> = {
  games: { name: "ana", provider: null, role: "admin" },
  betaso: { name: "bea", provider: "betaso", role: "admin" },
  betasoSupport: { name: "beto", provider: "betaso", role: "support" },
  parley: { name: "pia", provider: "parley", role: "admin" },
};
const adminTokens: AdminTokenCheck = async (token) => ADMINS[token];

async function serve(archive: MatchArchive): Promise<string> {
  const app = express()
    .use(express.json())
    .use(recordRoutes({ logger: fakeLogger(), archive, adminApiKey: KEY, adminTokens }))
    .use(httpErrorHandler(fakeLogger()));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const get = (url: string, key = KEY) =>
  fetch(url, { headers: key ? { "x-internal-api-key": key } : {} });

const getAs = (url: string, who: keyof typeof ADMINS) =>
  fetch(url, { headers: { authorization: `Bearer ${who}` } });

async function seeded(): Promise<MemoryHistory> {
  const history = new MemoryHistory();
  for (const id of ["m-1", "m-2", "m-3"]) {
    history.open(id, { ...SETUP, roomId: `room-${id}`, matchStartedAt: 1_000 });
    history.record([entry(1, { matchId: id })]);
    history.round(id, {
      roundNumber: 1,
      endReason: "DOMINO",
      starterId: "seat-1",
      hands: [],
    });
    // Un milisegundo entre partidas: el orden del listado es `createdAt`, el instante real.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  history.close("m-1", { ...CLOSING, roomId: "room-m-1" });
  return history;
}

describe("recordRoutes: lo que contestan", () => {
  it("el listado: la más nueva primero, por cursor, con el envelope del panel", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/internal/matches?pageSize=2`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; data: ListBody };
    expect(body.status).toBe("success");
    expect(Object.keys(body.data)).toEqual([
      "items",
      "pageSize",
      "nextCursor",
      "total",
      "totalExact",
    ]);
    // SIN FILTROS el total es el estimado de la colección: no exacto, aunque acá coincida.
    expect(body.data).toMatchObject({ pageSize: 2, total: 3, totalExact: false });
    expect(typeof body.data.nextCursor).toBe("string");
    expect(body.data.items.map((item) => item.matchId)).toEqual(["m-3", "m-2"]);
    expect(body.data.items[0]).toMatchObject({
      matchId: "m-3",
      roomId: "room-m-3",
      game: "domino",
      status: "started",
      // LOS MONTOS EN LA CONVENCIÓN (`recordView`): Mongo guarda `entryFeeInUC`, el panel lee la mesa
      // como entidad en UC.
      table: {
        gameModeId: SETUP.table.gameModeId,
        name: SETUP.table.name,
        currency: "UC",
        entryFee: "10.0000",
        prize: "18.0000",
        isFree: SETUP.table.isFree,
      },
      matchStartedAt: new Date(1_000).toISOString(),
    });
    expect(findBadAmounts(body.data.items, RECORD_MONEY_KEYS)).toEqual([]);
    // UN RESUMEN: ni la secuencia ni las manos, que son lo grande del documento.
    for (const item of body.data.items) {
      expect(item).not.toHaveProperty("timeline");
      expect(item).not.toHaveProperty("rounds");
    }

    const last = (await (
      await get(`${base}/internal/matches?pageSize=2&after=${body.data.nextCursor}`)
    ).json()) as { data: ListBody };
    expect(last.data.items).toHaveLength(1);
    expect(last.data.items[0]).toMatchObject({
      matchId: "m-1",
      status: "finished",
      matchEndReason: "SCORE",
      winnerIds: ["seat-1"],
    });
    // LA ÚLTIMA PÁGINA no promete otra, y con cursor no se cuenta.
    expect(last.data).toMatchObject({ nextCursor: null, total: null, totalExact: false });
  });

  it("los filtros llegan al archivo ya tipados, y el total filtrado es exacto", async () => {
    const base = await serve(await seeded());
    const record = (await (await get(`${base}/internal/matches/m-2`)).json()) as {
      data: { _id: string; createdAt: string };
    };
    const query = new URLSearchParams({
      userId: "u2",
      roomId: "room-m-2",
      matchId: "m-2",
      // EN MAYÚSCULAS: el `_id` se compara en minúscula, como lo escribe Mongo.
      id: record.data._id.toUpperCase(),
      from: record.data.createdAt,
      to: new Date(Date.parse(record.data.createdAt) + 1).toISOString(),
    });

    const body = (await (await get(`${base}/internal/matches?${query}`)).json()) as {
      data: ListBody;
    };

    expect(body.data.items.map((item) => item.matchId)).toEqual(["m-2"]);
    expect(body.data).toMatchObject({ nextCursor: null, total: 1, totalExact: true });
  });

  it("sin nada, la primera página de 20; cada parámetro, convertido", async () => {
    const list = vi.fn(
      async (_query: MatchListQuery): Promise<MatchListPage> => ({
        items: [],
        total: 0,
        totalExact: true,
      }),
    );
    const base = await serve({ ...untouched, list });

    const body = await (await get(`${base}/internal/matches`)).json();

    expect(list).toHaveBeenLastCalledWith({ pageSize: 20 });
    expect(body).toEqual({
      status: "success",
      data: { items: [], pageSize: 20, nextCursor: null, total: 0, totalExact: true },
    });

    const after = cursorOf({ t: Date.parse("2026-10-01T10:00:00.000Z"), id: "a".repeat(24) });
    await get(
      `${base}/internal/matches?pageSize=5&after=${after}&from=2026-10-01T00:00:00-04:00&to=2026-10-02T00:00:00.000Z&id=${"B".repeat(24)}&userId=u-ana&matchEndReason=CHARGE_REJECTED&status=aborted&tournamentId=t-copa`,
    );
    expect(list).toHaveBeenLastCalledWith({
      pageSize: 5,
      after: { createdAt: new Date("2026-10-01T10:00:00.000Z"), id: "a".repeat(24) },
      from: new Date("2026-10-01T04:00:00.000Z"),
      to: new Date("2026-10-02T00:00:00.000Z"),
      id: "b".repeat(24),
      userId: "u-ana",
      matchEndReason: "CHARGE_REJECTED",
      status: "aborted",
      tournamentId: "t-copa",
    });

    await get(`${base}/internal/matches?providerId=parley`);
    expect(list).toHaveBeenLastCalledWith({ pageSize: 20, providerId: "parley" });
  });

  // MÁS DE 100 NO ES UNA PÁGINA, ES LA COLECCIÓN: se rechaza en vez de recortarse en silencio. Y un
  // filtro que no se entiende es 400, no un listado sin ese filtro: el panel mostraría partidas que no
  // pidió como si fueran las que pidió.
  it.each([
    "pageSize=101",
    "pageSize=0",
    "pageSize=abc",
    "pageSize=2.5",
    "id=xyz",
    `id=${"g".repeat(24)}`,
    `id=${"a".repeat(25)}`,
    "from=ayer",
    "to=2026-13-01T00:00:00.000Z",
    "from=2026-10-01",
    "from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    "after=",
    "after=no*es*base64",
    `after=${Buffer.from("no es json").toString("base64url")}`,
    `after=${cursorOf({ t: "ayer", id: "a".repeat(24) })}`,
    `after=${cursorOf({ t: 1, id: "corto" })}`,
    `after=${cursorOf({ t: 1, id: "a".repeat(24), extra: true })}`,
    `after=${cursorOf({ t: 1.5, id: "a".repeat(24) })}`,
    "matchId=",
    `matchId=${"x".repeat(129)}`,
    "roomId=%07",
    "matchId=a&matchId=b",
    "userId=",
    `userId=${"u".repeat(129)}`,
    "userId=%00",
    "userId=ana&userId=beto",
    // EL TORNEO, con la regla de los demás ids: ni vacío, ni largo, ni con control, ni dos.
    "tournamentId=",
    `tournamentId=${"t".repeat(129)}`,
    "tournamentId=%00",
    "tournamentId=a&tournamentId=b",
    // EL PROVEEDOR, con la misma regla.
    "providerId=",
    `providerId=${"p".repeat(129)}`,
    "providerId=%00",
    "providerId=a&providerId=b",
    // EL MOTIVO, uno de los del dominó y escrito como él: ni inventado, ni en minúscula, ni dos.
    "matchEndReason=",
    "matchEndReason=GANÓ",
    "matchEndReason=score",
    "matchEndReason=SCORE&matchEndReason=ABANDONMENT",
    // EL ESTADO, uno de los tres y escrito como él: ni inventado, ni en mayúscula, ni dos.
    "status=",
    "status=open",
    "status=FINISHED",
    "status=started&status=finished",
  ])("un pedido imposible es 400 MALFORMED (%s)", async (query) => {
    const base = await serve(untouched);

    const response = await get(`${base}/internal/matches?${query}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MALFORMED" });
  });

  it("`from` igual a `to` es un rango vacío, no un error", async () => {
    const base = await serve(await seeded());

    const response = await get(
      `${base}/internal/matches?from=2026-10-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`,
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: ListBody }).data.items).toEqual([]);
  });

  // LA BASE NO CONTESTÓ EN SU PLAZO: un 503 que dice qué hacer, y no un request colgado ni un 500.
  it("un listado que excede su plazo es 503, con qué hacer", async () => {
    const base = await serve({
      ...untouched,
      list: () => Promise.reject(new MatchListTimeoutError()),
    });

    const response = await get(`${base}/internal/matches?from=2020-01-01T00:00:00.000Z`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "MATCH_LIST_TIMEOUT",
      detail: "La búsqueda tardó demasiado; acota el rango de fechas",
    });
  });

  it("un fallo del listado que no es el plazo sigue siendo 500", async () => {
    const base = await serve({ ...untouched, list: () => Promise.reject(new Error("caído")) });

    expect((await get(`${base}/internal/matches`)).status).toBe(500);
  });

  it("el detalle: el documento entero, con su `_id` como texto", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/internal/matches/m-1`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; data: Record<string, unknown> };
    expect(body.status).toBe("success");
    expect(body.data).toMatchObject({
      matchId: "m-1",
      version: 2.1,
      status: "finished",
      matchConfig: { seed: "seed-1", teamAssignment: "SHUFFLED" },
    });
    expect(body.data._id).toMatch(/^[0-9a-f]{24}$/);
    expect(Object.keys(body.data).slice(-2)).toEqual(["rounds", "timeline"]);
    // NINGÚN MONTO FUERA DE LA CONVENCIÓN: la cabecera, los asientos, la plata de cada uno y el
    // aumento, cada entidad con su `currency`.
    expect(findBadAmounts(body.data, RECORD_MONEY_KEYS)).toEqual([]);
    expect(JSON.stringify(body.data)).not.toMatch(/InUC|InPlayerCurrency|"uc"/);
    expect(body.data.table).toMatchObject({
      currency: "UC",
      entryFee: "10.0000",
      prize: "18.0000",
    });
  });

  it("el detalle de una partida que no existe es 404", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/internal/matches/no-existe`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "MATCH_NOT_FOUND" });
  });

  // EL CONTRATO DEL BACKEND PRINCIPAL (truco `4472332`): el documento pelado, sin envelope ni `_id`.
  it("`/game-data/:roomId` devuelve el documento guardado, pelado", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/game-data/room-m-2`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ matchId: "m-2", roomId: "room-m-2", status: "started" });
    expect(body).not.toHaveProperty("_id");
    expect(body).not.toHaveProperty("status", "success");
    expect((body.timeline as unknown[]).length).toBe(1);
    expect(findBadAmounts(body, RECORD_MONEY_KEYS)).toEqual([]);
    expect(body.table).toMatchObject({ currency: "UC", entryFee: "10.0000" });
  });

  it("`/game-data` de una partida que no está guardada es 404 `MATCH_NOT_FOUND`", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/game-data/no-existe`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "MATCH_NOT_FOUND" });
  });

  // LA LLAVE PRIMERO: sin ella las tres contestan 401, y antes de validar la forma.
  it.each([
    "/internal/matches",
    "/internal/matches?pageSize=999",
    "/internal/matches?id=no-es-un-id",
    "/internal/matches/m-1",
    "/game-data/room-m-1",
  ])("sin credencial, %s es 401", async (path) => {
    const base = await serve(untouched);

    expect((await get(`${base}${path}`, "")).status).toBe(401);
    expect((await get(`${base}${path}`, "otra-llave-de-16-chars")).status).toBe(401);
  });

  // "LA BASE NO CONTESTA" NO ES "NO HAY NADA": un fallo del lector sube al manejador y es 500.
  it("un fallo del archivo es 500, no un 404", async () => {
    const base = await serve({
      ...untouched,
      recordOf: () => Promise.reject(new Error("mongo caído")),
    });

    expect((await get(`${base}/internal/matches/m-1`)).status).toBe(500);
  });
});

// EL ÁMBITO POR PROVEEDOR: el listado y el detalle abren a los admins de un proveedor, acotados por el
// `providerId` de los asientos; `/game-data` sigue siendo de Tablea Gaming.
describe("recordRoutes: el ámbito de un proveedor", () => {
  const listing = () =>
    vi.fn(
      async (_query: MatchListQuery): Promise<MatchListPage> => ({
        items: [],
        total: 0,
        totalExact: true,
      }),
    );

  it("al listado de un proveedor se le fuerza el suyo, con o sin nombrarlo", async () => {
    const list = listing();
    const base = await serve({ ...untouched, list });

    for (const who of ["betaso", "betasoSupport"] as const) {
      expect((await getAs(`${base}/internal/matches?userId=u-1`, who)).status).toBe(200);
      expect(list).toHaveBeenLastCalledWith({ pageSize: 20, userId: "u-1", providerId: "betaso" });
      expect((await getAs(`${base}/internal/matches?providerId=betaso`, who)).status).toBe(200);
      expect(list).toHaveBeenLastCalledWith({ pageSize: 20, providerId: "betaso" });
    }
  });

  it("un `?providerId=` ajeno es 404 UNKNOWN_PROVIDER, sin leer el archivo", async () => {
    const base = await serve(untouched);

    const response = await getAs(`${base}/internal/matches?providerId=parley`, "betaso");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "UNKNOWN_PROVIDER" });
  });

  it("Tablea Gaming lista todo, o filtra por el proveedor que nombre", async () => {
    const list = listing();
    const base = await serve({ ...untouched, list });

    await getAs(`${base}/internal/matches`, "games");
    expect(list).toHaveBeenLastCalledWith({ pageSize: 20 });
    await getAs(`${base}/internal/matches?providerId=parley`, "games");
    expect(list).toHaveBeenLastCalledWith({ pageSize: 20, providerId: "parley" });
  });

  // DE PUNTA A PUNTA CONTRA EL ARCHIVO DE MEMORIA: la cruzada sale para los dos, la de un solo
  // proveedor para ése, y la que no tiene el campo para ninguno.
  async function provided(): Promise<MemoryHistory> {
    const history = new MemoryHistory();
    // Un asiento sin proveedor es el de un documento grabado antes de que el orquestador lo mandara.
    const seats = (providers: readonly (string | undefined)[]) =>
      SETUP.seats.map((seat, index) => {
        const providerId = providers[index];
        const { providerId: _old, ...anonymous } = seat;
        return (providerId === undefined ? anonymous : { ...seat, providerId }) as typeof seat;
      });
    const rows: [string, (string | undefined)[]][] = [
      ["m-betaso", ["betaso", "betaso"]],
      ["m-cruzada", ["betaso", "parley"]],
      ["m-sin", []],
    ];
    for (const [matchId, providers] of rows) {
      history.open(matchId, {
        ...SETUP,
        roomId: `room-${matchId}`,
        seats: seats(providers),
        matchStartedAt: 1_000,
      });
      // Un milisegundo entre partidas: el orden del listado es `createdAt`, el instante real.
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    return history;
  }

  it("cada proveedor lista las partidas de sus jugadores, y Tablea todas", async () => {
    const base = await serve(await provided());
    const ids = async (who: keyof typeof ADMINS) =>
      (
        (await (await getAs(`${base}/internal/matches`, who)).json()) as { data: ListBody }
      ).data.items.map((item) => item.matchId);

    expect(await ids("betaso")).toEqual(["m-cruzada", "m-betaso"]);
    expect(await ids("parley")).toEqual(["m-cruzada"]);
    expect(await ids("games")).toEqual(["m-sin", "m-cruzada", "m-betaso"]);
  });

  it("el detalle de una partida sin jugadores del proveedor es 404, como una que no existe", async () => {
    const base = await serve(await provided());

    for (const [who, matchId] of [
      ["parley", "m-betaso"],
      ["betaso", "m-sin"],
      ["betaso", "no-existe"],
    ] as const) {
      const response = await getAs(`${base}/internal/matches/${matchId}`, who);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "MATCH_NOT_FOUND" });
    }
    // LA CRUZADA LA VEN LOS DOS, cada uno desde su lado: su asiento entero, el del otro recortado.
    // Tablea la ve entera.
    const providersSeen = async (who: keyof typeof ADMINS) => {
      const response = await getAs(`${base}/internal/matches/m-cruzada`, who);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { seats: { providerId?: string }[] } };
      return body.data.seats.map((seat) => seat.providerId);
    };
    expect(await providersSeen("betaso")).toEqual(["betaso", undefined]);
    expect(await providersSeen("betasoSupport")).toEqual(["betaso", undefined]);
    expect(await providersSeen("parley")).toEqual([undefined, "parley"]);
    expect(await providersSeen("games")).toEqual(["betaso", "parley"]);
    expect((await getAs(`${base}/internal/matches/m-sin`, "games")).status).toBe(200);
  });

  // UNA CASUAL CRUZADA Y CERRADA, con plata y precio en los dos asientos. Todo lo de B lleva marcas
  // únicas (`canario-b`, `987654`, la moneda `XCB`); su nombre visible y su usuario son la excepción
  // aceptada y no llevan marca. Lo que alcanza un admin de A —listado y detalle— no trae ninguna; A ve lo
  // suyo entero, y Tablea ve todo.
  async function crossedAndClosed(): Promise<MemoryHistory> {
    const history = new MemoryHistory();
    const priceA = { currency: "VES", rate: "200", entry: "2000.00", prize: "3600.00", levels: [] };
    const priceB = {
      currency: "XCB",
      rate: "98765.432",
      entry: "987654.32",
      prize: "1975308.64",
      levels: [{ level: 2, entry: "987654.32", prize: "3950617.28" }],
    };
    const [baseA, baseB] = SETUP.seats as [
      MatchSetup["seats"][number],
      MatchSetup["seats"][number],
    ];
    const seatA = { ...baseA, userId: "ana-a", providerId: "betaso", price: priceA };
    const seatB = {
      ...baseB,
      userId: "canario-b-user",
      displayName: "Rival",
      username: "rival",
      currency: "XCB",
      providerId: "canario-b-prov",
      price: priceB,
    };
    const setup = { ...SETUP, roomId: "room-x", seats: [seatA, seatB] };
    history.open("m-x", { ...setup, matchStartedAt: 1_000 });
    history.record([entry(1, { matchId: "m-x" })]);
    history.close("m-x", {
      ...CLOSING,
      ...setup,
      rateId: "rate-x",
      players: [
        {
          ...seatA,
          finalScore: 104,
          chargedInUC: 10,
          prizePaidInUC: 18,
          chargedInPlayerCurrency: "2000.00",
          prizePaidInPlayerCurrency: "3600.00",
        },
        {
          ...seatB,
          finalScore: 40,
          chargedInUC: 10,
          prizePaidInUC: 0,
          chargedInPlayerCurrency: "987654.32",
          prizePaidInPlayerCurrency: "0.00",
          exit: { reason: "TIMEOUT", at: 30_000, roundNumber: 2 },
        },
      ],
    });
    return history;
  }

  it("el admin de un proveedor no recibe nada privado del asiento del otro (canario)", async () => {
    const base = await serve(await crossedAndClosed());
    const CANARY = /canario-b|987654|XCB/;

    const list = await getAs(`${base}/internal/matches`, "betaso");
    expect(list.status).toBe(200);
    const listed = await list.text();
    expect(listed).toContain("m-x");
    expect(listed).not.toMatch(CANARY);

    const detail = await getAs(`${base}/internal/matches/m-x`, "betaso");
    expect(detail.status).toBe(200);
    const text = await detail.text();
    expect(text).not.toMatch(CANARY);
    const { data } = JSON.parse(text) as {
      data: { seats: Record<string, unknown>[]; players: Record<string, unknown>[] };
    };
    // EL ASIENTO PROPIO, ENTERO: identidad, proveedor, precio y plata en su moneda.
    expect(data.seats[0]).toMatchObject({ userId: "ana-a", providerId: "betaso", currency: "VES" });
    expect(data.players[0]).toMatchObject({
      userId: "ana-a",
      currency: "VES",
      charged: "2000.00",
      prizePaid: "3600.00",
    });
    // EL DEL OTRO, CERRADO: sólo lo que el jugador vio en la mesa.
    expect(data.seats[1]).toEqual({
      id: "seat-2",
      teamId: "B",
      seat: 1,
      displayName: "Rival",
      username: "rival",
    });
    expect(data.players[1]).toEqual({
      id: "seat-2",
      teamId: "B",
      seat: 1,
      displayName: "Rival",
      username: "rival",
      finalScore: 40,
      exit: { reason: "TIMEOUT", at: "1970-01-01T00:00:30.000Z", roundNumber: 2 },
    });

    // TABLEA LO VE TODO, y el otro proveedor ve su asiento entero.
    const all = await (await getAs(`${base}/internal/matches/m-x`, "games")).text();
    expect(all).toContain("canario-b-user");
    expect(all).toContain("987654.32");
    const canarySide = await getAs(`${base}/internal/matches/m-x`, "parley");
    expect(canarySide.status).toBe(404);
  });

  it("`/game-data` sigue cerrado a un proveedor", async () => {
    const base = await serve(await provided());

    const response = await getAs(`${base}/game-data/room-m-betaso`, "betaso");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN" });
    expect((await getAs(`${base}/game-data/room-m-betaso`, "games")).status).toBe(200);
  });
});
