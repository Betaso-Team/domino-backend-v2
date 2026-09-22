import { type Server, createServer } from "node:http";
import { HttpClient } from "@/shared/http";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CachedAntifraudFlag } from "../antifraud-flag";
import { HttpAntifraudFlag } from "../transports/http-flag";

// A CONTRACT test. What has to be right is the route, the credential and — above all — what happens
// when the backend does not answer.
describe("HttpAntifraudFlag (contrato con el backend principal)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ url: string; apiKey?: string }>;
  let respond: () => { status: number; body: unknown };

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", apiKey: req.headers["x-internal-api-key"] as string });
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("sin puerto");
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  beforeEach(() => {
    requests = [];
    respond = () => ({ status: 200, body: { enabled: true } });
  });

  const build = () => new HttpAntifraudFlag(new HttpClient({ baseUrl }), { value: "la-api-key" });

  it("pregunta con la API key del servidor", async () => {
    expect(await build().isRematchRulesEnabled()).toBe(true);

    expect(requests[0]?.url).toBe("/antifraud-settings/rematch-enabled");
    expect(requests[0]?.apiKey).toBe("la-api-key");
  });

  it("apagado es apagado", async () => {
    respond = () => ({ status: 200, body: { enabled: false } });

    expect(await build().isRematchRulesEnabled()).toBe(false);
  });

  // This is the file's point: the error has to COME OUT so whoever knows what to do with it catches
  // it. Degrading it to `false` here would mean taking this endpoint down turns the antifraude off.
  it("un fallo del backend NO se degrada a apagado: se propaga", async () => {
    respond = () => ({ status: 500, body: {} });

    await expect(build().isRematchRulesEnabled()).rejects.toThrow();
  });

  it("y arriba, el fail-safe lo deja ENCENDIDO", async () => {
    respond = () => ({ status: 500, body: {} });
    const cached = new CachedAntifraudFlag(build(), 5_000, () => 0, new MemoryLogger());

    expect(await cached.isRematchRulesEnabled()).toBe(true);
  });
});
