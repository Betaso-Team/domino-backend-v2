import { bootTestServer, mintToken } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL CABLEADO, que es lo que ninguna pieza puede medir sola: que `app.config.ts` monte la ruta con el
// verificador de billing-auth de verdad y el historial del container. Lo que contesta está medido en
// `transports/http/me.int.test.ts` y en el contrato de los adaptadores.
const PORT = 2622;

describe("GET /me/matches en el servidor de verdad", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it("con el token de billing-auth contesta la página del dueño", async () => {
    const res = await fetch(`http://localhost:${PORT}/me/matches`, {
      headers: { authorization: `Bearer ${mintToken("sin-partidas")}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [], page: 1, perPage: 10, totalItems: 0 });
  });

  it("sin token es 401", async () => {
    expect((await fetch(`http://localhost:${PORT}/me/matches`)).status).toBe(401);
  });
});
