import { type Server, createServer } from "node:http";
import { DeadlineExceededError } from "@/shared/deadline";
import { HttpClient, HttpError } from "@/shared/http";
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

// EL PLAZO CUBRE EL INTERCAMBIO ENTERO Y CORTA EL SOCKET. Un servidor que manda las cabeceras y se
// cuelga en el cuerpo es el caso que un plazo alrededor de `fetch` no veía: el cobro de la entrada se
// quedaba esperando el `text()` para siempre y la mesa, en `charging`.
describe("HttpClient y su plazo", () => {
  const TIMEOUT_MS = 200;
  let server: Server;
  let baseUrl: string;
  let closed: Promise<void>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      closed = new Promise((resolve) => req.socket.once("close", () => resolve()));
      if (req.url === "/cuerpo-colgado") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"a":');
      } else if (req.url === "/error-colgado") {
        res.writeHead(500, { "content-type": "application/json" });
        res.write('{"code":');
      }
      // `/sin-cabeceras`: no contesta nada.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("sin puerto");
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const client = () => new HttpClient({ baseUrl, timeoutMs: TIMEOUT_MS });

  async function timed<T>(work: Promise<T>): Promise<{ error: unknown; ms: number }> {
    const started = performance.now();
    const error = await work.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    return { error, ms: performance.now() - started };
  }

  it("cabeceras enviadas y cuerpo colgado: vence en plazo y corta el socket", async () => {
    const { error, ms } = await timed(client().get("cuerpo-colgado"));

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(ms).toBeLessThan(TIMEOUT_MS + 500);
    await closed;
  });

  it("sin cabeceras: vence en plazo y corta el socket", async () => {
    const { error, ms } = await timed(client().post("sin-cabeceras", { a: 1 }));

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(ms).toBeLessThan(TIMEOUT_MS + 500);
    await closed;
  });

  // EL STATUS YA DECIDE: un 500 con el cuerpo cortado sigue siendo una respuesta, no un plazo.
  it("un 500 con el cuerpo colgado rechaza en plazo con su status", async () => {
    const { error, ms } = await timed(client().post("error-colgado", {}));

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500 });
    expect(ms).toBeLessThan(TIMEOUT_MS + 500);
    await closed;
  });
});
