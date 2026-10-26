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

function fakeLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

// UN VERIFICADOR QUE CONOCE DOS TOKENS: lo que se mide acá es la ruta, no la firma de billing-auth
// (ésa la mide `jwt-verifier.test.ts`).
const verifier: TokenVerifier = {
  verify: (token): Promise<Identity> =>
    token === "tok-u1" || token === "tok-u2"
      ? Promise.resolve({ userId: token.slice(4) })
      : Promise.reject(new InvalidTokenError("inválido")),
};

const servers: Server[] = [];
async function serve(players: PlayerLog): Promise<string> {
  const app = express()
    .use(express.json())
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

const get = (url: string, token?: string) =>
  fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function seeded(): Promise<MemoryHistory> {
  const history = new MemoryHistory();
  history.open("m-1", { ...SETUP, matchStartedAt: 1 });
  history.close("m-1", CLOSING);
  history.open("m-2", { ...SETUP, roomId: "room-2", matchStartedAt: 2 });
  await history.drain();
  return history;
}

describe("GET /me/matches: lo que jugó el dueño del token", () => {
  it("sin verificador no se registra", () => {
    expect(routesOf(meRoutes({ players: new MemoryHistory(), logger: fakeLogger() }))).toEqual([]);
  });

  it("sin token o con uno inválido es 401, y no consulta", async () => {
    const pageOf = vi.fn();
    const base = await serve({ pageOf });

    expect((await get(`${base}/me/matches`)).status).toBe(401);
    expect((await get(`${base}/me/matches`, "otro")).status).toBe(401);
    expect(pageOf).not.toHaveBeenCalled();
  });

  // LA CUENTA SALE DEL TOKEN Y DE NINGÚN OTRO LADO: no hay forma de pedir la de otro.
  it("devuelve sólo las terminadas, desde el asiento del dueño del token", async () => {
    const base = await serve(await seeded());
    const response = await get(`${base}/me/matches`, "tok-u1");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      items: [{ id: "m-1", result: "win", bet: 10, prize: 18, score: 104 }],
      page: 1,
      perPage: 10,
      totalItems: 1,
    });
    expect(await (await get(`${base}/me/matches`, "tok-u2")).json()).toMatchObject({
      items: [{ id: "m-1", result: "abandoned", prize: 0 }],
    });
  });

  it("pasa la página y el tamaño pedidos, y rechaza un tamaño de más", async () => {
    const pageOf = vi.fn().mockResolvedValue({ items: [] });
    const base = await serve({ pageOf });

    await get(`${base}/me/matches?page=3&limit=5`, "tok-u1");
    expect(pageOf).toHaveBeenCalledWith("u1", 3, 5);
    expect((await get(`${base}/me/matches?limit=51`, "tok-u1")).status).toBe(400);
    expect((await get(`${base}/me/matches?page=0`, "tok-u1")).status).toBe(400);
  });

  it("si la base no contesta a tiempo es 503 y no 500", async () => {
    const base = await serve({ pageOf: () => Promise.reject(new MatchListTimeoutError()) });

    expect((await get(`${base}/me/matches`, "tok-u1")).status).toBe(503);
  });
});
