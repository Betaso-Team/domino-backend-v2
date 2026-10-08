import { settingsSignal } from "@/di-container";
import { env } from "@/env";
import { bootTestServer } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SETTINGS_ROUTE } from "../transports/http/settings";

// LEER Y EDITAR LA CONFIGURACIÓN de punta a punta: la llave, las cotas, el rechazo de un campo no
// editable y el refresco del proceso que atendió la escritura. Se levanta el servidor de verdad
// porque lo que se mide es el camino entero — un middleware en el orden equivocado no se ve de otra
// manera, ni una ruta registrada después del comodín. Portado de truco (`3cab0f8`).
const PORT = 2611;
const url = (path = "") => `http://127.0.0.1:${PORT}${SETTINGS_ROUTE}${path}`;
const admin = {
  "Content-Type": "application/json",
  "x-internal-api-key": env.adminApiKey ?? "",
};

interface Section {
  readonly name: string;
  readonly effective: Record<string, number>;
  readonly overrides: Record<string, unknown>;
  readonly editable: readonly string[];
}

const call = async <T = Section>(method: string, path: string, body?: unknown) => {
  const res = await fetch(url(path), {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
};

describe("Los endpoints de configuración (integración)", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    await server.shutdown();
  });

  afterEach(async () => {
    await call("DELETE", "/match");
  });

  it("sin llave no se entra, ni siquiera a mirar", async () => {
    expect((await fetch(url())).status).toBe(401);
  });

  // CADA LLAVE ABRE LO SUYO (truco `ebf22dd`): la que presenta el orquestador para abrir mesas no
  // puede mover los plazos del juego.
  it("la llave del orquestador no abre el panel", async () => {
    const res = await fetch(url(), {
      headers: { "x-internal-api-key": env.orchestratorApiKey ?? "" },
    });

    expect(res.status).toBe(401);
  });

  it("lista las secciones con lo que está en vigor y lo que se puede tocar", async () => {
    const { data } = await call<Section[]>("GET", "");

    // `deal` y `starting-score` existen porque la suite corre como `local` (`isDevEnvironment`).
    expect(data.map((section) => section.name)).toEqual(["match", "deal", "starting-score"]);
    expect(data[0]?.effective).toMatchObject({ turnTimeoutMs: env.turnTimeoutMs });
    expect(data[0]?.overrides).toEqual({});
    expect(data[0]?.editable).toContain("presentingRoundMs");
    expect(data[0]?.editable).not.toContain("tilesPerPlayer");
  });

  it("un parche cambia UN campo y deja el resto en su default", async () => {
    const before = (await call("GET", "/match")).data.effective;

    const { status, data } = await call("PATCH", "/match", { presentingRoundMs: 6000 });

    expect(status).toBe(200);
    expect(data.overrides).toEqual({ presentingRoundMs: 6000 });
    expect(data.effective).toEqual({ ...before, presentingRoundMs: 6000 });
  });

  it("lo que contesta ya es lo que ese proceso va a usar", async () => {
    await call("PATCH", "/match", { presentingRoundMs: 6000 });

    expect(settingsSignal.effective<{ presentingRoundMs: number }>("match")).toMatchObject({
      presentingRoundMs: 6000,
    });
  });

  it("el cero no entra: es el plazo vencido que despierta en bucle", async () => {
    expect((await call("PATCH", "/match", { presentingRoundMs: 0 })).status).toBe(400);
  });

  it("una clave con un typo se rechaza en vez de no hacer nada", async () => {
    expect((await call("PATCH", "/match", { presentinRoundMs: 6000 })).status).toBe(400);
  });

  it("lo que se lee al arrancar no se puede editar en caliente", async () => {
    expect((await call("PATCH", "/match", { tilesPerPlayer: 5 })).status).toBe(400);
  });

  it("una sección que nadie cableó contesta en el mismo idioma que el resto", async () => {
    const { status, data } = await call<{ code: string }>("GET", "/la-que-no-existe");

    expect(status).toBe(404);
    expect(data).toEqual({ code: "SETTINGS_SECTION_NOT_FOUND" });
  });

  it("borrar la sección devuelve los defaults", async () => {
    await call("PATCH", "/match", { presentingRoundMs: 6000 });

    const { data } = await call("DELETE", "/match");

    expect(data.overrides).toEqual({});
    expect(data.effective.presentingRoundMs).toBe(env.presentingRoundMs);
  });
});
