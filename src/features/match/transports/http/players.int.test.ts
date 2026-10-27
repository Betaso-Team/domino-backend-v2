import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Identity, InvalidTokenError, type TokenVerifier } from "@/features/auth";
import type { Logger } from "@/logger";
import { httpErrorHandler } from "@/shared/http/error-handler";
import { routesOf } from "@/tests/routes";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchListTimeoutError } from "../../network/history";
import type { PlayerLog } from "../../network/player-log";
import { MemoryHistory } from "../../network/transports/memory-history";
import { CLOSING, SETUP } from "../../network/transports/tests/history-contract";
import { meRoutes } from "./me";
import { playerRoutes } from "./players";

const KEY = "k".repeat(16);

function fakeLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

const servers: Server[] = [];
async function serve(players: PlayerLog): Promise<string> {
  // `/me/matches` montado al lado, con un verificador que acepta cualquier token como su `userId`: es
  // la otra mitad de la comparación de forma.
  const verifier: TokenVerifier = {
    verify: (token): Promise<Identity> =>
      token
        ? Promise.resolve({ userId: token })
        : Promise.reject(new InvalidTokenError("sin token")),
  };
  const app = express()
    .use(express.json())
    .use(playerRoutes({ players, logger: fakeLogger(), adminApiKey: KEY }))
    .use(meRoutes({ players, verifier, logger: fakeLogger() }))
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
  history.open("m-1", { ...SETUP, matchStartedAt: 1 });
  history.close("m-1", CLOSING);
  history.open("m-2", { ...SETUP, roomId: "room-2", matchStartedAt: 2 });
  await history.drain();
  return history;
}

describe("GET /internal/players/:userId/matches: el historial de un jugador, para el panel", () => {
  // FAIL CLOSED, como el resto de las rutas de administración.
  it("sin llave de administración no se registra, y el aviso la nombra", () => {
    const logger = fakeLogger();
    expect(
      routesOf(playerRoutes({ players: new MemoryHistory(), logger, adminApiKey: undefined })),
    ).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("GET /internal/players/:userId/matches"),
    );
  });

  it("sin llave o con otra es 401, y no consulta", async () => {
    const pageOf = vi.fn();
    const base = await serve({ pageOf });

    expect((await get(`${base}/internal/players/u1/matches`, "")).status).toBe(401);
    expect((await get(`${base}/internal/players/u1/matches`, "x".repeat(16))).status).toBe(401);
    expect(pageOf).not.toHaveBeenCalled();
  });

  it("devuelve las partidas de ESE jugador, desde su asiento, y no las de otro", async () => {
    const base = await serve(await seeded());

    const response = await get(`${base}/internal/players/u1/matches`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "success",
      data: {
        items: [{ id: "m-1", result: "win", bet: 10, prize: 18, score: 104 }],
        page: 1,
        perPage: 10,
        totalItems: 1,
      },
    });
    const other = (await (await get(`${base}/internal/players/u2/matches`)).json()) as {
      data: { items: unknown[] };
    };
    expect(other.data.items).toEqual([expect.objectContaining({ id: "m-1", result: "abandoned" })]);
    const stranger = (await (await get(`${base}/internal/players/nadie/matches`)).json()) as {
      data: { items: unknown[]; totalItems: number };
    };
    expect(stranger.data).toMatchObject({ items: [], totalItems: 0 });
  });

  // LA MISMA VISTA QUE VE EL JUGADOR: el panel no tiene otra forma de leer lo que el jugador reclama.
  it("el `data` es exactamente lo que `/me/matches` le contesta a ese jugador", async () => {
    const base = await serve(await seeded());

    const admin = (await (
      await get(`${base}/internal/players/u1/matches?page=1&limit=5`)
    ).json()) as {
      data: unknown;
    };
    const own = await (
      await fetch(`${base}/me/matches?page=1&limit=5`, { headers: { authorization: "Bearer u1" } })
    ).json();

    expect(admin.data).toEqual(own);
  });

  it("pasa la página y el tamaño pedidos, con los mismos límites que `/me/matches`", async () => {
    const pageOf = vi.fn().mockResolvedValue({ items: [] });
    const base = await serve({ pageOf });

    await get(`${base}/internal/players/u1/matches?page=3&limit=5`);
    expect(pageOf).toHaveBeenCalledWith("u1", 3, 5);
    expect((await get(`${base}/internal/players/u1/matches?limit=51`)).status).toBe(400);
    expect((await get(`${base}/internal/players/u1/matches?page=0`)).status).toBe(400);
  });

  // LA MISMA REGLA DE TEXTO QUE EL FILTRO `userId` DEL LISTADO: largo acotado, sin caracteres de control.
  it("un `userId` demasiado largo o con caracteres de control es 400, y no consulta", async () => {
    const pageOf = vi.fn();
    const base = await serve({ pageOf });

    expect((await get(`${base}/internal/players/${"a".repeat(129)}/matches`)).status).toBe(400);
    expect((await get(`${base}/internal/players/a%0Ab/matches`)).status).toBe(400);
    expect(pageOf).not.toHaveBeenCalled();
  });

  it("si la base no contesta a tiempo es 503 y no 500", async () => {
    const base = await serve({ pageOf: () => Promise.reject(new MatchListTimeoutError()) });

    expect((await get(`${base}/internal/players/u1/matches`)).status).toBe(503);
  });
});
