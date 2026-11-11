import { testConfig } from "@/app.config";
import { env } from "@/env";
import { mintAdminToken, mintBillingToken } from "@/tests/billing-auth-keys";
import { routesOf } from "@/tests/routes";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import type { Application, Router } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// TODO ERROR HTTP DEL DOMINÓ ES `{ code, detail? }`, Y ESTO LO MIDE SOBRE TODAS LAS RUTAS. Recorre las
// rutas que la app ensamblada registra de verdad (`routesOf` sobre el router de Express, no una lista
// escrita a mano) y a cada una le pega con las credenciales y los cuerpos que hacen fallar: sin
// credencial, con la de un proveedor, con la llave y un cuerpo vacío, con un JSON roto. Cada 4xx y
// 5xx que vuelve tiene que traer `code` y nada de la forma vieja (`error`, `status: "error"`,
// `message`). Una ruta nueva que escriba su error a mano se pone roja acá sin que nadie la agregue.
//
// `/health` y `/ready` quedan afuera: son sondas del balanceador, con su propia forma.
const PORT = 2652;
const URL = `http://127.0.0.1:${PORT}`;
const PROBES = new Set(["/health", "/ready"]);

type Credential = Record<string, string>;
const CREDENTIALS: Record<string, Credential> = {
  nadie: {},
  jugador: { authorization: `Bearer ${mintBillingToken("u-errores")}` },
  proveedor: { authorization: `Bearer ${mintAdminToken("pia", { prv: "parley", role: "admin" })}` },
  support: { authorization: `Bearer ${mintAdminToken("sol", { prv: null, role: "support" })}` },
  llave: { "x-internal-api-key": env.adminApiKey ?? "" },
  orquestador: { "x-internal-api-key": env.orchestratorApiKey ?? "" },
};

// Un parámetro de path que no existe pero tiene forma posible, para llegar más allá del schema.
const pathOf = (route: string): string => route.replace(/:[A-Za-z]+/g, "x-inexistente");

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly body: unknown;
}

async function call(method: string, path: string, headers: Credential, body?: string) {
  const response = await fetch(`${URL}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: parsed,
  } satisfies Answer;
}

let server: ColyseusTestServer;
let app: Application | undefined;

beforeAll(async () => {
  server = await boot(
    {
      ...testConfig,
      initializeExpress: (express: Application): void => {
        app = express;
        testConfig.initializeExpress?.(express);
      },
    },
    PORT,
  );
});

afterAll(async () => {
  await server.shutdown();
});

describe("la forma de los errores HTTP, en todas las rutas", () => {
  it('ningún 4xx ni 5xx trae `error` ni `status: "error"`: todos son { code, detail? }', async () => {
    if (!app) throw new Error("la app de Express no se inicializó");
    const routes = routesOf(app.router as unknown as Router)
      .map((route) => route.split(" ") as [string, string])
      // `router.all` se registra como `_all`: se prueba con GET.
      .map(([method, path]): [string, string] => [method === "_ALL" ? "GET" : method, path])
      .filter(([, path]) => !PROBES.has(path));
    // Sin rutas el test pasaría sin medir nada: si `routesOf` deja de entender el stack de Express,
    // esto lo dice.
    expect(routes.length).toBeGreaterThan(20);

    const failures: string[] = [];
    const codes = new Set<string>();
    for (const [method, route] of routes) {
      const path = pathOf(route);
      const attempts: Array<[string, Credential, string | undefined]> = Object.entries(
        CREDENTIALS,
      ).map(([who, headers]) => [who, headers, method === "GET" ? undefined : "{}"]);
      if (method !== "GET") attempts.push(["llave + JSON roto", CREDENTIALS.llave ?? {}, "{"]);
      for (const [who, headers, body] of attempts) {
        const answer = await call(method, path, headers, body);
        if (answer.status < 400) continue;
        const where = `${method} ${path} (${who}) → ${answer.status} ${JSON.stringify(answer.body)}`;
        const shape = answer.body as Record<string, unknown> | string;
        if (
          !answer.contentType.includes("application/json") ||
          typeof shape !== "object" ||
          shape === null
        ) {
          failures.push(`no es JSON: ${where}`);
          continue;
        }
        if (typeof shape.code !== "string") failures.push(`sin code: ${where}`);
        else codes.add(shape.code);
        const extra = Object.keys(shape).filter((key) => key !== "code" && key !== "detail");
        if (extra.length > 0) failures.push(`claves de más (${extra.join(", ")}): ${where}`);
        if (shape.detail !== undefined && typeof shape.detail !== "string") {
          failures.push(`detail no es texto: ${where}`);
        }
      }
    }

    expect(failures).toEqual([]);
    // Y que el recorrido llegó a donde tenía que llegar: la puerta, la forma y una respuesta de cada
    // feature.
    for (const code of [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "MALFORMED",
      "MATCH_NOT_FOUND",
      "NO_LIVE_MATCH",
    ]) {
      expect(codes).toContain(code);
    }
  });
});
