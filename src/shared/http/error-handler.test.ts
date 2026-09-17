import type { LogFields, Logger } from "@/logger.js";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { httpErrorHandler } from "./error-handler.js";

function recordingLogger(): { logger: Logger; calls: Array<[string, LogFields | undefined]> } {
  const calls: Array<[string, LogFields | undefined]> = [];
  const noop = () => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: (message, fields) => calls.push([message, fields]),
    child: () => logger,
  };
  return { logger, calls };
}

// Un doble de Response que solo anota qué se respondió. Levantar Express para esto mediría
// el framework y no el manejador; lo que se decide acá es el status, el cuerpo y a quién se
// le cuenta el detalle.
function fakeResponse(headersSent = false) {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    headersSent,
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, sent };
}

const request = {} as Request;

describe("httpErrorHandler", () => {
  it("responde 500 en JSON, no la página HTML por defecto de Express", () => {
    const { logger } = recordingLogger();
    const { response, sent } = fakeResponse();

    httpErrorHandler(logger)(new Error("bug"), request, response, vi.fn() as NextFunction);

    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: "INTERNAL" });
  });

  // El detalle es de quien OPERA el servidor, no del cliente: un 500 es un bug nuestro y
  // decir cuál es filtrar la cocina. Queda en el log para que se vea, con el stack entero.
  it("loguea el stack pero no lo manda en la respuesta", () => {
    const { logger, calls } = recordingLogger();
    const cause = new Error("la llave del historial estaba mal cargada");
    const { response, sent } = fakeResponse();

    httpErrorHandler(logger)(cause, request, response, vi.fn() as NextFunction);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.detail).toBe(cause.stack);
    expect(JSON.stringify(sent.body)).not.toContain("historial");
    // El nombre del archivo es lo que aparece en cualquier stack de este repo: si alguna vez
    // el cuerpo lo llevara, la filtración se vería acá y no en producción.
    expect(JSON.stringify(sent.body)).not.toContain("error-handler");
  });

  // Con la respuesta ya en vuelo no hay 500 que mandar: el status y las cabeceras ya salieron.
  it("si la respuesta ya empezó, delega en el manejador por defecto", () => {
    const { logger } = recordingLogger();
    const next = vi.fn();
    const cause = new Error("tarde");
    const { response, sent } = fakeResponse(true);

    httpErrorHandler(logger)(cause, request, response, next as NextFunction);

    expect(next).toHaveBeenCalledWith(cause);
    expect(sent.status).toBeUndefined();
  });
});
