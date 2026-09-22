import { matchmaker, settingsSignal } from "@/di-container";
import { env } from "@/env";
import { bootTestServer } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SETTINGS_ROUTE } from "../transports/http/register-http";

// LEER Y EDITAR LA CONFIGURACIÓN de punta a punta: la llave, las cotas, el rechazo de un campo no
// editable y el refresco del proceso que atendió la escritura. Se levanta el servidor de verdad
// porque lo que se mide es el camino entero — un middleware en el orden equivocado no se ve de otra
// manera, ni una ruta registrada después del comodín. Portado de truco (`3cab0f8`).
const PORT = 2611;
const url = (path = "") => `http://127.0.0.1:${PORT}${SETTINGS_ROUTE}${path}`;
const admin = { "Content-Type": "application/json", "X-Internal-Key": env.internalApiKey ?? "" };

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
    await call("DELETE", "/matchmaking");
  });

  it("sin llave no se entra, ni siquiera a mirar", async () => {
    expect((await fetch(url())).status).toBe(401);
  });

  it("lista las secciones con lo que está en vigor y lo que se puede tocar", async () => {
    const { data } = await call<Section[]>("GET", "");

    expect(data.map((section) => section.name)).toEqual(["match", "matchmaking"]);
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
    expect((await call("PATCH", "/matchmaking", { tickIntervalMs: 100 })).status).toBe(400);
  });

  // EL EMPAREJADOR LEE LA SUYA AL USAR: el mismo proceso ve el número editado sin reiniciar. Lo
  // que el emparejador expone de su config es lo que el composition root le pasó, una función.
  it("el emparejamiento toma el cambio sin reiniciar", async () => {
    await call("PATCH", "/matchmaking", { searchTimeoutMs: 45_000 });

    const { config } = (
      matchmaker as unknown as { deps: { config: () => { searchTimeoutMs: number } } }
    ).deps;
    expect(config().searchTimeoutMs).toBe(45_000);
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
