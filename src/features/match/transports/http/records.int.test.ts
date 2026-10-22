import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@/logger";
import { httpErrorHandler } from "@/shared/http/error-handler";
import { routesOf } from "@/tests/routes";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryReader, MatchArchive } from "../../network/history";
import { MemoryHistory } from "../../network/transports/memory-history";
import { CLOSING, SETUP, entry } from "../../network/transports/tests/history-contract";
import { recordRoutes } from "./records";
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
  page: () => Promise.reject(new Error("el registro de la ruta no debe leer el archivo")),
};

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
      "GET /config/:roomId",
      "GET /internal/matches/:matchId/history",
      "GET /internal/matches",
      "GET /internal/matches/:matchId",
      "GET /game-data/:roomId",
      "POST /internal/matches",
      "POST /internal/players/:userId/seat",
      "GET /internal/census",
    ]);
  });
});

// Un Express DE VERDAD sobre un puerto efímero, con el mismo parser y el mismo manejador de errores que
// `app.config.ts`: lo que se mide son status y cuerpos, y eso lo decide Express.
const servers: Server[] = [];
async function serve(archive: MatchArchive): Promise<string> {
  const app = express()
    .use(express.json())
    .use(recordRoutes({ logger: fakeLogger(), archive, adminApiKey: KEY }))
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
  it("el listado: la más nueva primero, paginado, con el envelope del panel", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/internal/matches?page=1&pageSize=2`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      data: { items: Record<string, unknown>[]; page: number; pageSize: number; total: number };
    };
    expect(body.status).toBe("success");
    expect(body.data).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(body.data.items.map((item) => item.matchId)).toEqual(["m-3", "m-2"]);
    expect(body.data.items[0]).toMatchObject({
      matchId: "m-3",
      roomId: "room-m-3",
      game: "domino",
      status: "started",
      table: SETUP.table,
      matchStartedAt: new Date(1_000).toISOString(),
    });
    // UN RESUMEN: ni la secuencia ni las manos, que son lo grande del documento.
    for (const item of body.data.items) {
      expect(item).not.toHaveProperty("timeline");
      expect(item).not.toHaveProperty("rounds");
    }

    const last = (await (await get(`${base}/internal/matches?page=2&pageSize=2`)).json()) as {
      data: { items: Record<string, unknown>[] };
    };
    expect(last.data.items).toHaveLength(1);
    expect(last.data.items[0]).toMatchObject({
      matchId: "m-1",
      status: "finished",
      matchEndReason: "SCORE",
      winnerIds: ["seat-1"],
    });
  });

  it("sin página, la primera de 25", async () => {
    const page = vi.fn(async () => ({ items: [], total: 0 }));
    const base = await serve({ ...untouched, page });

    const body = await (await get(`${base}/internal/matches`)).json();

    expect(page).toHaveBeenCalledWith(1, 25);
    expect(body).toEqual({
      status: "success",
      data: { items: [], page: 1, pageSize: 25, total: 0 },
    });
  });

  // MÁS DE 100 NO ES UNA PÁGINA, ES LA COLECCIÓN: se rechaza en vez de recortarse en silencio.
  it.each(["pageSize=101", "pageSize=0", "page=0", "page=abc", "pageSize=2.5"])(
    "una página imposible es 400 (%s)",
    async (query) => {
      const base = await serve(untouched);
      expect((await get(`${base}/internal/matches?${query}`)).status).toBe(400);
    },
  );

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
  });

  it("el detalle de una partida que no existe es 404", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/internal/matches/no-existe`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "error", message: "Partida no encontrada" });
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
  });

  it("`/game-data` de una partida que no está guardada es 404 `MATCH_NOT_FOUND`", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/game-data/no-existe`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "MATCH_NOT_FOUND" });
  });

  // LA LLAVE PRIMERO: sin ella las tres contestan 401, y antes de validar la forma.
  it.each([
    "/internal/matches",
    "/internal/matches?pageSize=999",
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
