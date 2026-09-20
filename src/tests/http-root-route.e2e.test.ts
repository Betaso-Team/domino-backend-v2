import { testConfig } from "@/app.config";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import type { Application } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// GUARDIA DE UNA PROPIEDAD QUE NO ES NUESTRA: que una ruta raíz registrada en Express le
// gane al banner `Colyseus x.y.z`. Hoy domino no registra ningún `GET /`, así que este
// archivo lo registra ÉL, sobre la misma configuración real, y mide el servidor levantado.
//
// Por qué gana, medido y no deducido (Colyseus 0.18.5):
//   1. `Server.listen()` hace `await this._bootForListen()` ANTES de `this.bindRoutes()`
//      (`@colyseus/core/build/Server.mjs:68` y `:93`), y es `_bootForListen` el que llama a
//      nuestro `initializeExpress` (`:257`). Cuando corre `bindRouterToTransport` (`:159`)
//      la app de Express YA tiene todas sus rutas.
//   2. Por eso `hasExpressRootRoute` las ve (`router/index.mjs:67`) y Colyseus NO registra
//      su propio `/` (`router/index.mjs:26-28`); sin endpoint `/` en su router, el
//      `findRoute` del listener antepuesto no matchea y la request cae en
//      `expressApp.handle()` (`router/index.mjs:39` y `:45`).
//
// Que sea un test y no un comentario es el punto: el chequeo de la raíz vive en una
// dependencia, así que un bump de Colyseus puede invertir el orden sin avisar. Si eso pasa,
// este `it` se pone rojo mostrando el banner en vez de nuestro cuerpo — y no se descubre el
// día que alguien agregue una raíz de verdad y la vea ignorada sin un solo error.
//
// Puerto propio: el arnés e2e reserva del 2585 al 2590.
const PORT = 2591;
const BODY = "raiz-de-domino";

let server: ColyseusTestServer;

beforeAll(async () => {
  const withRootRoute = {
    ...testConfig,
    initializeExpress: (app: Application) => {
      testConfig.initializeExpress?.(app);
      app.get("/", (_req, res) => {
        res.type("text/plain").send(BODY);
      });
    },
  };
  server = await boot(withRootRoute, PORT);
});

afterAll(async () => {
  await server.shutdown();
});

describe("la ruta raíz de Express contra el banner de Colyseus", () => {
  it("un GET / registrado en la app de Express es el que contesta", async () => {
    const response = await fetch(`http://localhost:${PORT}/`);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(BODY);
    // Explícito además del `toBe`: si algún día el banner vuelve a ganar, el mensaje del
    // fallo nombra al culpable en vez de mostrar dos strings que no se parecen en nada.
    expect(body).not.toContain("Colyseus");
  });
});
