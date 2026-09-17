import type { AddressInfo } from "node:net";
import type { Logger } from "@/logger.js";
import express, { type Application as Express } from "express";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../network/history.js";
import { registerInternalHistoryHttp } from "./register-http.js";

// El logger entra por parámetro, así que el doble se arma acá y no hay container que
// preparar: ésa es justamente la propiedad que el transporte ganó al dejar de resolver.
function fakeLogger(): Logger {
  const noop = vi.fn();
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

// Un doble de Express que solo anota QUÉ rutas se registraron. No hace falta levantar un
// servidor: lo que se mide acá es una decisión de wiring —si la ruta llega a existir—, y
// el comportamiento de la ruta ya lo cubren los tests e2e con la llave puesta.
function pathsRegisteredWith(internalApiKey: string | undefined): string[] {
  const paths: string[] = [];
  const app = { get: (path: string) => paths.push(path) } as unknown as Express;
  registerInternalHistoryHttp(app, {
    logger: fakeLogger(),
    // El historial nunca se toca en estos dos casos: lo que se mide es el registro de la
    // ruta, no su handler. Si alguna vez se llama, `of` truena y el test lo dice.
    history: {
      of: () => {
        throw new Error("el registro de la ruta no debe leer el historial");
      },
    },
    internalApiKey,
  });
  return paths;
}

describe("registerInternalHistoryHttp", () => {
  // FAIL CLOSED. La alternativa —registrar igual y comparar contra una llave vacía— deja
  // una ruta interna viva que el operador ve responder y cree protegida.
  it("sin llave interna la ruta de soporte no llega a existir", () => {
    expect(pathsRegisteredWith(undefined)).toEqual([]);
  });

  it("con llave interna la ruta de soporte se registra", () => {
    expect(pathsRegisteredWith("k".repeat(16))).toEqual(["/internal/matches/:matchId/history"]);
  });

  // El aviso es lo ÚNICO que explica el 404 de una instancia sin llave, así que se mide que
  // nombre la ruta: un warn que dice "falta INTERNAL_API_KEY" y no dice cuál path se apagó
  // no lo encuentra el que busca por path.
  it("sin llave interna avisa nombrando la ruta que no se registró", () => {
    const logger = fakeLogger();
    const app = { get: () => undefined } as unknown as Express;

    registerInternalHistoryHttp(app, {
      logger,
      history: { of: () => Promise.resolve([]) },
      internalApiKey: undefined,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("/internal/matches/:matchId/history"),
    );
  });

  it("responde las entradas ordenadas por seq sin mutar al lector", async () => {
    const entries = [3, 1, 2].map(
      (seq): HistoryEntry => ({
        matchId: "history-order",
        seq,
        at: seq,
        roundNumber: 1,
        source: "PLAYER",
        kind: "COMMAND",
        type: "PASS",
        payload: { playerId: "seat-1" },
      }),
    );
    const app = express();
    registerInternalHistoryHttp(app, {
      logger: fakeLogger(),
      history: { of: () => Promise.resolve(entries) },
      internalApiKey: "k".repeat(16),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/matches/history-order/history`,
        {
          headers: { "X-Internal-Key": "k".repeat(16) },
        },
      );
      const body = (await response.json()) as { entries: readonly HistoryEntry[] };

      expect(body.entries.map(({ seq }) => seq)).toEqual([1, 2, 3]);
      expect(entries.map(({ seq }) => seq)).toEqual([3, 1, 2]);
    } finally {
      server.close();
    }
  });
});
