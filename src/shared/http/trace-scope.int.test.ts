import type { Server } from "node:http";
import type { LogFields, Logger } from "@/shared/logger";
import { currentTrace } from "@/shared/trace";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { requestLog } from "./request-log";
import { traceScope } from "./trace-scope";

// Contra un Express REAL y por `fetch`: lo que hay que medir es que la causa llegue al fondo de la
// cadena atravesando los `await` de los handlers, y eso no se ve llamando un middleware a mano.

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function serve(log: Logger) {
  const app = express();
  app.use(traceScope());
  app.use(requestLog(log));
  app.get("/eco", async (_req, res) => {
    // Un `await` en el medio, que es la parte que un contexto mal propagado pierde.
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.json({ traceId: currentTrace()?.traceId ?? null });
  });

  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("sin puerto");
  return (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}/eco`, { headers }).then(
      (response) => response.json() as Promise<{ traceId: string | null }>,
    );
}

// Un logger que, en vez de guardar lo que le dicen, guarda la causa QUE VE al emitir. Es lo único
// que prueba el invariante: que la línea sale desde ADENTRO del alcance, y no sólo que sale.
class TraceSpy implements Logger {
  readonly seen: Array<string | undefined> = [];
  readonly info = (_message: string, _fields?: LogFields) => {
    this.seen.push(currentTrace()?.traceId);
  };
  readonly debug = this.info;
  readonly warn = this.info;
  readonly error = this.info;
  child(): Logger {
    return this;
  }
}

const parent = (traceId: string, spanId: string) => ({
  traceparent: `00-${traceId}-${spanId}-01`,
});

describe("la causa de una request", () => {
  it("llega hasta el handler, después de un `await`", async () => {
    const get = await serve(new TraceSpy());

    expect((await get()).traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("continúa la del que nos llamó", async () => {
    const get = await serve(new TraceSpy());
    const traceId = "a".repeat(32);

    expect((await get(parent(traceId, "b".repeat(16)))).traceId).toBe(traceId);
  });

  // ES POR ESTO QUE EL ALCANCE VA PRIMERO: la línea que cierra la request se emite desde adentro,
  // así que lleva la causa. Al revés no la llevaría.
  it("y la línea de la request se emite ADENTRO de la causa", async () => {
    const spy = new TraceSpy();
    const get = await serve(spy);
    const traceId = "c".repeat(32);

    await get(parent(traceId, "d".repeat(16)));

    expect(spy.seen).toEqual([traceId]);
    expect(currentTrace()).toBeUndefined();
  });

  // El escenario real de un servidor, y el que un contexto guardado en un módulo suelto arruinaría.
  it("dos requests a la vez no se pisan", async () => {
    const get = await serve(new TraceSpy());
    const one = "e".repeat(32);
    const two = "f".repeat(32);

    const [a, b] = await Promise.all([
      get(parent(one, "1".repeat(16))),
      get(parent(two, "2".repeat(16))),
    ]);

    expect(a.traceId).toBe(one);
    expect(b.traceId).toBe(two);
  });
});
