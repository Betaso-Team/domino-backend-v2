import { type Server, createServer } from "node:http";
import { HttpClient } from "@/shared/http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpCoreLoopClient } from "../transports/http-core-loop";

// UN TEST DE CONTRATO contra un servidor real. Lo que hay que acertar es la ruta, la credencial, el
// cuerpo que sale, y a qué se degrada una respuesta mal formada. Es el contrato del v1 del dominó
// (`core-loop/core-loop.service.ts`): `game: "domino"` y la llave en `x-internal-api-key`.
describe("HttpCoreLoopClient (contrato con el backend principal)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ url: string; apiKey?: string; body: unknown }>;
  let respond: () => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        requests.push({
          url: req.url ?? "",
          apiKey: req.headers["x-internal-api-key"] as string,
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
        });
        const { status, body } = respond();
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("sin puerto");
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const RESULT = {
    userId: "u1",
    rakeWaived: true,
    rake0Remaining: 4,
    softWindowRemaining: 9,
    alreadySettled: false,
  };

  beforeEach(() => {
    requests = [];
    respond = () => ({ status: 200, body: { enabled: true, results: [RESULT] } });
  });

  const build = () => new HttpCoreLoopClient(new HttpClient({ baseUrl }), { value: "la-api-key" });
  const settle = () =>
    build().settle({
      matchId: "m1",
      currency: "USD",
      paid: true,
      participants: [{ userId: "u1", won: true }],
    });

  it("manda el contrato exacto: ruta, api key y game:domino", async () => {
    await settle();

    expect(requests[0]?.url).toBe("/internal/core-loop/matches/settle");
    expect(requests[0]?.apiKey).toBe("la-api-key");
    expect(requests[0]?.body).toEqual({
      matchId: "m1",
      currency: "USD",
      paid: true,
      game: "domino",
      participants: [{ userId: "u1", won: true }],
    });
  });

  it("devuelve los resultados tal cual", async () => {
    expect(await settle()).toEqual({ enabled: true, results: [RESULT] });
  });

  it("respuesta sin `results` (feature apagada mal formada): arreglo vacío, no lanza", async () => {
    respond = () => ({ status: 200, body: { enabled: false } });

    expect(await settle()).toEqual({ enabled: false, results: [] });
  });

  // EL PUNTO DE ESTE ARCHIVO: un fallo de red o HTTP tiene que SALIR para que quien llama decida qué
  // significa "no hubo respuesta". Degradarlo acá se lo escondería al que tiene que fallar cerrado.
  it("un fallo del backend NO se degrada: se propaga", async () => {
    respond = () => ({ status: 500, body: {} });

    await expect(settle()).rejects.toThrow();
  });

  it("los settings parciales se completan campo por campo con el neutro", async () => {
    respond = () => ({ status: 200, body: { enabled: true, softTimeoutSeconds: 35 } });

    const settings = await build().settings();

    expect(requests[0]?.url).toBe("/internal/core-loop/settings");
    expect(settings).toMatchObject({ enabled: true, softTimeoutSeconds: 35, winrateCeiling: 1 });
  });
});
