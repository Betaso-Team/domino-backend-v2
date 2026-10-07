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

const request: CreateMatchRequest = {
  mode: "CASUAL",
  matchId: "m-1",
  gameModeId: "mode-2p",
  participants: [
    { userId: "p-a", displayName: "ana", currency: "VES" },
    { userId: "p-b", displayName: "beto", currency: "VES" },
  ],
  seed: "seed-1",
  teamAssignment: "SEAT_ORDER",
  rateId: "69977c3dc3bf3e710572f941",
};

type PublicConfig = Awaited<ReturnType<TablesDeps["registry"]["publicConfigOf"]>>;

const deps = (over: Partial<TablesDeps> = {}): TablesDeps => ({
  tables: {
    openRequest: async (r) => ({
      roomId: "room-1",
      seats: r.participants.map(({ userId }) => ({ userId, reservation: { sessionId: userId } })),
    }),
    seatBack: async () => ({ sessionId: "again" }),
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
    }),
  },
  logger: fakeLogger(),
  orchestratorApiKey: KEY,
  ...over,
});

// Un Express DE VERDAD sobre un puerto efímero, con el mismo parser y el mismo manejador de
// errores que `app.config.ts`: lo que se mide son status y cuerpos, y eso lo decide Express.
const servers: Server[] = [];
async function serve(over: Partial<TablesDeps> = {}): Promise<string> {
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

  it("contesta 422 con el código cuando la sala rechaza la mesa", async () => {
    const base = await serve({
      tables: {
        openRequest: async () => {
          throw new Error("UNKNOWN_GAME_MODE: no hay un modo activo con uuid x");
        },
        seatBack: vi.fn(),
      },
    });
    const res = await post(`${base}/internal/matches`, request);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "UNKNOWN_GAME_MODE" });
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
      data: { matchId: "m-1", reservation: { sessionId: "again" } },
    });
  });

  it("contesta 404 a quien no está en ninguna mesa, o cuya sala ya no existe", async () => {
    expect((await post(`${await serve()}/internal/players/p-z/seat`)).status).toBe(404);
    const gone = await serve({ tables: { openRequest: vi.fn(), seatBack: async () => undefined } });
    const res = await post(`${gone}/internal/players/p-a/seat`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NO_LIVE_MATCH" });
  });
});
