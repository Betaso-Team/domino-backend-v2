import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@/logger";
import { httpErrorHandler } from "@/shared/http/error-handler";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateMatchRequest } from "../match-contract";
import { type TablesDeps, tablesRoutes } from "./tables";

const KEY = "k".repeat(16);

function fakeLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

const request = {
  mode: "CASUAL",
  matchId: "m-1",
  gameModeId: "mode-2p",
  gameMode: {
    name: "Clásica",
    playersQuantity: 2,
    pointsToWin: 100,
    multiplier: 1,
    entryFee: 1.5,
    prize: 2.5,
    isFreeRoom: false,
    enableBots: false,
  },
  participants: [
    { userId: "p-a", displayName: "ana", currency: "VES" },
    { userId: "p-b", displayName: "beto", currency: "VES" },
  ],
  seed: "seed-1",
  teamAssignment: "SEAT_ORDER",
  rateId: "69977c3dc3bf3e710572f941",
} satisfies CreateMatchRequest;

type PublicConfig = Awaited<ReturnType<TablesDeps["registry"]["publicConfigOf"]>>;

// LAS DOS DEPENDENCIAS CON MÉTODOS SE PISAN DE A UNO: un caso nombra solo lo que cambia, y lo demás
// sigue siendo la mesa feliz de abajo.
type Over = Omit<Partial<TablesDeps>, "tables" | "registry"> & {
  readonly tables?: Partial<TablesDeps["tables"]>;
  readonly registry?: Partial<TablesDeps["registry"]>;
};

const deps = ({ tables, registry, ...over }: Over = {}): TablesDeps => ({
  tables: {
    openRequest: async (r) => ({
      roomId: "room-1",
      seats: r.participants.map(({ userId }) => ({ userId, reservation: { sessionId: userId } })),
    }),
    seatBack: async () => ({ sessionId: "again" }),
    isGone: async () => false,
    ...tables,
  },
  registry: {
    matchOf: async (userId) => (userId === "p-a" ? "room-1" : undefined),
    publicConfigOf: async () => ({ matchId: "m-1" }) as PublicConfig,
    census: async () => ({
      playersInMatch: 6,
      byGameMode: new Map([
        ["mode-2p", 4],
        ["mode-4p", 2],
      ]),
      byTournament: new Map([["t-1", 2]]),
    }),
    forget: async () => undefined,
    isLive: async (matchId) => matchId === "m-live",
    ...registry,
  },
  archive: { hasRecord: async (matchId) => matchId === "m-live" || matchId === "m-stored" },
  logger: fakeLogger(),
  orchestratorApiKey: KEY,
  ...over,
});

// Un Express DE VERDAD sobre un puerto efímero, con el mismo parser y el mismo manejador de
// errores que `app.config.ts`: lo que se mide son status y cuerpos, y eso lo decide Express.
const servers: Server[] = [];
async function serve(over: Over = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(tablesRoutes(deps(over)));
  app.use(httpErrorHandler(fakeLogger()));
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

const post = (url: string, body: unknown = {}, key: string | null = KEY) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-internal-api-key": key } : {}) },
    body: JSON.stringify(body),
  });

describe("tablesRoutes", () => {
  // FAIL CLOSED, como el historial: sin llave las rutas no existen, y el aviso las nombra.
  it("sin llave del orquestador no registra nada y avisa nombrando las rutas", () => {
    const logger = fakeLogger();
    const router = tablesRoutes(deps({ logger, orchestratorApiKey: undefined }));
    expect(router.stack).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("/internal/matches"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("/internal/players/:userId/seat"),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("/internal/census"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("/internal/players/:userId/match"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("/internal/matches/:matchId/existence"),
    );
  });

  describe("GET /internal/matches/:matchId/existence", () => {
    const ask = (base: string, matchId: string, key: string | null = KEY) =>
      fetch(`${base}/internal/matches/${matchId}/existence`, {
        headers: key ? { "x-internal-api-key": key } : {},
      });

    it("dice solo si la mesa sigue viva y si quedó registro, nunca el registro", async () => {
      const base = await serve();
      for (const [matchId, data] of [
        ["m-live", { live: true, recorded: true }],
        ["m-stored", { live: false, recorded: true }],
        ["m-never", { live: false, recorded: false }],
      ] as const) {
        const res = await ask(base, matchId);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "success", data });
      }
    });

    it("ante una falla del registro o de la base es 503, nunca un false", async () => {
      const registryDown = await serve({
        registry: {
          matchOf: vi.fn(),
          publicConfigOf: vi.fn(),
          census: vi.fn(),
          isLive: async () => {
            throw new Error("redis caído");
          },
        },
      });
      expect((await ask(registryDown, "m-never")).status).toBe(503);
      const archiveDown = await serve({
        archive: {
          hasRecord: async () => {
            throw new Error("mongo caído");
          },
        },
      });
      const res = await ask(archiveDown, "m-never");
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: "UNAVAILABLE" });
    });

    it("solo con la llave del orquestador", async () => {
      const base = await serve();
      expect((await ask(base, "m-live", null)).status).toBe(401);
      expect((await ask(base, "m-live", "x".repeat(16))).status).toBe(401);
    });
  });

  it("cuenta quién juega, en total y por modo, solo con la llave", async () => {
    const base = await serve();
    const res = await fetch(`${base}/internal/census`, { headers: { "x-internal-api-key": KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "success",
      data: {
        playersInMatch: 6,
        byGameMode: [
          { gameModeId: "mode-2p", playersInMatch: 4 },
          { gameModeId: "mode-4p", playersInMatch: 2 },
        ],
        byTournament: [{ tournamentId: "t-1", playersInMatch: 2 }],
      },
    });
    expect((await fetch(`${base}/internal/census`)).status).toBe(401);
  });

  it("abre la mesa y devuelve un asiento por participante", async () => {
    const res = await post(`${await serve()}/internal/matches`, request);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      status: "success",
      data: {
        roomId: "room-1",
        seats: [
          { userId: "p-a", reservation: { sessionId: "p-a" } },
          { userId: "p-b", reservation: { sessionId: "p-b" } },
        ],
      },
    });
  });

  it("pide la llave antes de mirar el cuerpo, y no acepta la de otro", async () => {
    const base = await serve();
    expect((await post(`${base}/internal/matches`, { basura: true }, null)).status).toBe(401);
    expect((await post(`${base}/internal/matches`, request, "otra-llave-de-16ch")).status).toBe(
      401,
    );
  });

  it("rechaza un cuerpo fuera del contrato, y la economía que manda el llamador", async () => {
    const base = await serve();
    expect((await post(`${base}/internal/matches`, { ...request, entryFee: 1 })).status).toBe(400);
    expect((await post(`${base}/internal/matches`, { ...request, rateId: " " })).status).toBe(400);
  });

  // EL MODO EN LÍNEA: viaja tal cual a la sala; sin él, o fuera de las guardas, es 400.
  it("pasa el modo en línea a la sala, y rechaza uno ausente o fuera del contrato", async () => {
    const { gameMode, ...withoutMode } = request;
    const opened: CreateMatchRequest[] = [];
    const base = await serve({
      tables: {
        ...deps().tables,
        openRequest: async (r) => {
          opened.push(r);
          return deps().tables.openRequest(r);
        },
      },
    });

    expect((await post(`${base}/internal/matches`, { ...request, gameMode })).status).toBe(201);
    expect(opened[0]).toMatchObject({ gameModeId: "mode-2p", gameMode });
    expect((await post(`${base}/internal/matches`, withoutMode)).status).toBe(400);
    for (const bad of [{ multiplier: 1.5 }, { pointsToWin: 0 }, { entryFee: -1 }, { extra: 1 }]) {
      expect(
        (await post(`${base}/internal/matches`, { ...request, gameMode: { ...gameMode, ...bad } }))
          .status,
      ).toBe(400);
    }
  });

  it("abre una mesa de torneo, y le rechaza cualquier campo de dinero", async () => {
    const base = await serve();
    const { gameModeId: _m, gameMode: _g, rateId: _r, ...rest } = request;
    const tournament = {
      ...rest,
      mode: "TOURNAMENT",
      tournamentId: "t-1",
      rules: { pointsToWin: 100 },
    };
    expect((await post(`${base}/internal/matches`, tournament)).status).toBe(201);
    expect((await post(`${base}/internal/matches`, { ...tournament, rateId: "r" })).status).toBe(
      400,
    );
    expect((await post(`${base}/internal/matches`, { ...tournament, mode: "CASUAL" })).status).toBe(
      400,
    );
  });

  it("contesta 422 con el código cuando la sala rechaza la mesa", async () => {
    const base = await serve({
      tables: {
        openRequest: async () => {
          throw new Error("SEAT_COUNT_MISMATCH: el modo x sienta 4 jugadores y el pedido trae 2");
        },
        seatBack: vi.fn(),
      },
    });
    const res = await post(`${base}/internal/matches`, request);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "SEAT_COUNT_MISMATCH" });
  });

  it("contesta 500 ante cualquier otra falla, sin disfrazarla de rechazo", async () => {
    const base = await serve({
      tables: {
        openRequest: async () => {
          throw new Error("se cayó el driver");
        },
        seatBack: vi.fn(),
      },
    });
    expect((await post(`${base}/internal/matches`, request)).status).toBe(500);
  });

  it("devuelve el asiento de quien sigue en una mesa, con el matchId", async () => {
    const res = await post(`${await serve()}/internal/players/p-a/seat`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "success",
      data: { matchId: "m-1", mode: "CASUAL", reservation: { sessionId: "again" } },
    });
  });

  it("contesta 404 a quien no está en ninguna mesa, o cuya sala ya no existe", async () => {
    expect((await post(`${await serve()}/internal/players/p-z/seat`)).status).toBe(404);
    const gone = await serve({ tables: { openRequest: vi.fn(), seatBack: async () => undefined } });
    const res = await post(`${gone}/internal/players/p-a/seat`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "NO_LIVE_MATCH" });
  });

  // T-04 (truco `53d1030`): la sala de un proceso muerto deja su entrada en el registro hasta que vence.
  // Sin borrarla, cada pregunta del orquestador la volvía a encontrar y el jugador quedaba trabado.
  it("cuando la sala ya no existe, borra la entrada del jugador antes de contestar 404", async () => {
    const forget = vi.fn(async () => undefined);
    const base = await serve({ tables: { seatBack: async () => undefined }, registry: { forget } });
    const res = await post(`${base}/internal/players/p-a/seat`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "NO_LIVE_MATCH" });
    expect(forget).toHaveBeenCalledWith("p-a", "room-1");
  });

  // «No sé» no es «no existe»: el gateway relanza cuando la sala sigue o no pudo confirmarlo, y ahí la
  // entrada se queda —borrarla le abriría al jugador una segunda mesa—.
  it("si la reserva falla con la sala en pie, contesta 500 y no borra nada", async () => {
    const forget = vi.fn(async () => undefined);
    const base = await serve({
      tables: {
        seatBack: async () => {
          throw new Error("process p-9 is not available.");
        },
      },
      registry: { forget },
    });
    expect((await post(`${base}/internal/players/p-a/seat`)).status).toBe(500);
    expect(forget).not.toHaveBeenCalled();
  });

  it("a quien no está en ninguna mesa no le borra nada", async () => {
    const forget = vi.fn(async () => undefined);
    const base = await serve({ registry: { forget } });
    expect((await post(`${base}/internal/players/p-z/seat`)).status).toBe(404);
    expect(forget).not.toHaveBeenCalled();
  });

  // LA MESA DE UN JUGADOR SIN RESERVAR: dos GET al registro y una lectura del registro de salas, sin
  // reservar nada.
  describe("GET /internal/players/:userId/match", () => {
    const get = (url: string, key: string | null = KEY) =>
      fetch(url, { headers: key ? { "x-internal-api-key": key } : {} });

    it("devuelve el matchId y el roomId de quien sigue en una mesa, sin reservar asiento", async () => {
      const seatBack = vi.fn();
      const res = await get(
        `${await serve({ tables: { openRequest: vi.fn(), seatBack } })}/internal/players/p-a/match`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "success",
        data: { matchId: "m-1", roomId: "room-1", mode: "CASUAL" },
      });
      expect(seatBack).not.toHaveBeenCalled();
    });

    it("dice si la mesa es de torneo, y de cuál", async () => {
      const base = await serve({
        registry: {
          matchOf: async () => "room-1",
          publicConfigOf: async () =>
            ({ matchId: "m-1", mode: "TOURNAMENT", tournamentId: "t-1" }) as PublicConfig,
          census: vi.fn(),
          isLive: vi.fn(),
        },
      });
      expect(await (await get(`${base}/internal/players/p-a/match`)).json()).toEqual({
        status: "success",
        data: { matchId: "m-1", roomId: "room-1", mode: "TOURNAMENT", tournamentId: "t-1" },
      });
    });

    it("contesta 404 NO_LIVE_MATCH a quien no está en ninguna mesa, o cuya config ya no está", async () => {
      const none = await get(`${await serve()}/internal/players/p-z/match`);
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ code: "NO_LIVE_MATCH" });

      const gone = await serve({
        registry: {
          matchOf: async () => "room-1",
          publicConfigOf: async () => undefined,
          census: vi.fn(),
          isLive: vi.fn(),
        },
      });
      const res = await get(`${gone}/internal/players/p-a/match`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: "NO_LIVE_MATCH" });
    });

    // T-04: la entrada de una sala que ya no figura en el matchmaker es de un proceso muerto.
    it("si la sala ya no existe, borra la entrada y contesta 404 NO_LIVE_MATCH", async () => {
      const forget = vi.fn(async () => undefined);
      const isGone = vi.fn(async () => true);
      const base = await serve({ tables: { isGone }, registry: { forget } });
      const res = await get(`${base}/internal/players/p-a/match`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: "NO_LIVE_MATCH" });
      expect(isGone).toHaveBeenCalledWith("room-1");
      expect(forget).toHaveBeenCalledWith("p-a", "room-1");
    });

    it("con la sala en pie (o sin poder confirmarlo) contesta como siempre y no borra nada", async () => {
      const forget = vi.fn(async () => undefined);
      const res = await get(`${await serve({ registry: { forget } })}/internal/players/p-a/match`);
      expect(res.status).toBe(200);
      expect(forget).not.toHaveBeenCalled();
    });

    it("pide la llave antes que nada, y no acepta la de otro", async () => {
      const base = await serve();
      const sinLlave = await get(`${base}/internal/players/p-a/match`, null);
      expect(sinLlave.status).toBe(401);
      expect(await sinLlave.json()).toEqual({ code: "UNAUTHORIZED" });
      expect((await get(`${base}/internal/players/p-a/match`, "otra-llave-de-16ch")).status).toBe(
        401,
      );
    });

    it("rechaza un userId de forma imposible con 400 MALFORMED", async () => {
      const res = await get(`${await serve()}/internal/players/${"x".repeat(129)}/match`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "MALFORMED" });
    });
  });
});
