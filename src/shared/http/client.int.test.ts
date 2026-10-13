import { type Server, createServer } from "node:http";
import { HttpClient } from "@/shared/http";
import { newTrace, traceparentOf, withTrace } from "@/shared/trace";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// UN TEST DE CONTRATO, contra un servidor real y no contra una capa HTTP de mentira: lo que hay que
// acertar es lo que VIAJA POR EL CABLE, que es justo lo que el backend principal va a leer para
// cruzar sus logs con los nuestros. Portado de truco.

describe("HttpClient y la causa en curso", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string | undefined>[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      headers.push(req.headers as Record<string, string | undefined>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("sin puerto");
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    headers = [];
  });

  it("manda el `traceparent` sin que el llamador lo mencione", async () => {
    const trace = newTrace();

    await withTrace(trace, () => new HttpClient({ baseUrl }).get("algo"));

    expect(headers[0]?.traceparent).toBe(traceparentOf(trace));
  });

  // Las dos formas dicen LO MISMO, así que un consumidor que lea sólo una obtiene el mismo valor y el
  // cruce funciona por cualquiera de los dos lados.
  it("y el `x-request-id` de respaldo, con el mismo identificador", async () => {
    const trace = newTrace();

    await withTrace(trace, () => new HttpClient({ baseUrl }).post("algo", { a: 1 }));

    expect(headers[0]?.["x-request-id"]).toBe(trace.traceId);
  });

  it("sin causa en curso no inventa ninguna", async () => {
    await new HttpClient({ baseUrl }).get("algo");

    expect(headers[0]?.traceparent).toBeUndefined();
    expect(headers[0]?.["x-request-id"]).toBeUndefined();
  });

  // La traza se AGREGA a lo que el adaptador ya mandaba: pisar la llave interna, por ejemplo, dejaría
  // sin autenticar al anillo entero.
  it("no pisa las cabeceras del que llama", async () => {
    await withTrace(newTrace(), () =>
      new HttpClient({ baseUrl }).post("algo", { a: 1 }, { "x-internal-api-key": "secreta" }),
    );

    expect(headers[0]?.["x-internal-api-key"]).toBe("secreta");
    expect(headers[0]?.["content-type"]).toBe("application/json");
    expect(headers[0]?.traceparent).toBeDefined();
  });
});
