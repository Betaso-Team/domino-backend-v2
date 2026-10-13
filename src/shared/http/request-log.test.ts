import { EventEmitter } from "node:events";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { requestLog } from "./request-log";

// La respuesta es un emisor de eventos DE VERDAD, porque lo único que hay que acertar es CUÁNDO
// habla: cuando la respuesta terminó, y no cuando llega la request.

function fakeReq(over: Partial<Request> = {}): Request {
  return { method: "GET", path: "/game-modes/abc", ...over } as Request;
}

function fakeRes(statusCode = 200): Response & { finish(): void; abort(): void } {
  const res = new EventEmitter() as Response & { finish(): void; abort(): void };
  res.statusCode = statusCode;
  // Express emite `close` también después de un `finish`: el log tiene que salir UNA vez igual.
  res.finish = () => {
    res.emit("finish");
    res.emit("close");
  };
  res.abort = () => res.emit("close");
  return res;
}

describe("el log de requests", () => {
  it("no dice nada hasta que la respuesta terminó, y lo dice una sola vez", () => {
    const log = new MemoryLogger();
    const res = fakeRes();

    requestLog(log)(fakeReq(), res, vi.fn() as NextFunction);
    expect(log.lines).toEqual([]);

    res.finish();
    expect(log.lines).toHaveLength(1);
  });

  it("sigue la cadena: un middleware que no llama a `next` cuelga el servidor", () => {
    const next = vi.fn();

    requestLog(new MemoryLogger())(fakeReq(), fakeRes(), next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });

  it("una línea con el método, la ruta, el status y cuánto tardó", () => {
    const log = new MemoryLogger();
    const res = fakeRes(204);

    requestLog(log)(fakeReq({ method: "POST" }), res, vi.fn() as NextFunction);
    res.finish();

    expect(log.lines[0]?.level).toBe("info");
    expect(log.lines[0]?.msg).toBe("request");
    expect(log.lines[0]?.fields).toMatchObject({
      method: "POST",
      path: "/game-modes/abc",
      status: 204,
    });
    expect(log.lines[0]?.fields.ms).toBeTypeOf("number");
    expect(log.lines[0]?.fields).not.toHaveProperty("aborted");
  });

  // Con la ruta PEDIDA cada identificador sería un valor distinto, y agrupar por endpoint dejaría
  // de ser posible.
  it("usa la ruta REGISTRADA y no la pedida", () => {
    const log = new MemoryLogger();
    const res = fakeRes();
    const req = fakeReq({ route: { path: "/game-modes/:uuid" } as Request["route"] });

    requestLog(log)(req, res, vi.fn() as NextFunction);
    res.finish();

    expect(log.lines[0]?.fields.path).toBe("/game-modes/:uuid");
  });

  // LA QUE NO TERMINÓ es justo la que uno va a buscar cuando algo anda mal: el cliente cortó, el
  // socket se reseteó, un handler se colgó. Con sólo `finish` era invisible.
  it("la request que no terminó también deja su línea, marcada", () => {
    const log = new MemoryLogger();
    const res = fakeRes();

    requestLog(log)(fakeReq(), res, vi.fn() as NextFunction);
    res.abort();

    expect(log.lines[0]?.fields).toMatchObject({ aborted: true });
  });

  // Un 4xx no es un error NUESTRO, y un 500 ya lo gritó el manejador de errores: repetirlo acá
  // sería la línea duplicada que "el que decide, registra" prohíbe.
  it("el status no cambia el nivel: siempre `info`", () => {
    const log = new MemoryLogger();

    for (const status of [200, 404, 500]) {
      const res = fakeRes(status);
      requestLog(log)(fakeReq(), res, vi.fn() as NextFunction);
      res.finish();
    }

    expect(log.lines.map((line) => line.level)).toEqual(["info", "info", "info"]);
  });
});
