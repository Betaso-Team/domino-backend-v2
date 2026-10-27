import { env } from "@/env";
import { mintAdminToken } from "@/tests/billing-auth-keys";
import { bootTestServer } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL ÁMBITO DE CADA ADMIN, DE PUNTA A PUNTA: un token firmado como lo firma billing-auth, el
// verificador de verdad, la puerta de verdad y la ruta montada por `app.config.ts`. Vive acá arriba
// porque cruza tres features —catálogo, partida y configuración— y lo que mide es el CABLEADO: que
// ninguna ruta de administración se haya montado sin decir a quién abre.
//
// ⚠ ES EL HUECO ENTRE DESPLIEGUES: el día que billing-auth emite tokens de operador, todo lo que no
// diga `providers` tiene que contestarle 403 a un admin de Parley. Una ruta nueva detrás de
// `requireAdminKey` sin acotar ya queda cerrada por el default; ésta es la lista de las que hay hoy.
const PORT = 2633;
const URL = `http://127.0.0.1:${PORT}`;

const TOKENS = {
  games: mintAdminToken("ana"),
  legacy: mintAdminToken("viejo"),
  support: mintAdminToken("sol", { prv: null, role: "support" }),
  parley: mintAdminToken("pia", { prv: "parley", role: "admin" }),
  parleySupport: mintAdminToken("pedro", { prv: "parley", role: "support" }),
  rival: mintAdminToken("rita", { prv: "rival", role: "admin" }),
};
type Who = keyof typeof TOKENS | "key" | "orchestrator";

const headersOf = (who: Who): Record<string, string> => {
  if (who === "key") return { "x-internal-api-key": env.adminApiKey ?? "" };
  if (who === "orchestrator") return { "x-internal-api-key": env.orchestratorApiKey ?? "" };
  return { authorization: `Bearer ${TOKENS[who]}` };
};

async function call(who: Who, method: string, path: string, body?: unknown) {
  const response = await fetch(`${URL}${path}`, {
    method,
    headers: {
      ...headersOf(who),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

describe("el ámbito de los admins (integración)", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    await server.shutdown();
  });

  // LAS RUTAS DE BETASO GAMES: un operador no entra a ninguna, ni a leer. `support` lee y no escribe.
  // Los 404 de una lectura son de la ruta (no hay tal partida), o sea que la puerta ya dejó pasar.
  const reads: Array<[string, string]> = [
    ["GET", "/internal/matches"],
    ["GET", "/internal/matches/m-inexistente"],
    ["GET", "/internal/matches/m-inexistente/history"],
    ["GET", "/game-data/r-inexistente"],
    ["GET", "/internal/settings"],
    ["GET", "/internal/settings/match"],
  ];

  it.each(reads)("%s %s: Betaso Games y support entran, un operador no", async (method, path) => {
    for (const who of ["games", "legacy", "support", "key"] as const) {
      expect([200, 404]).toContain((await call(who, method, path)).status);
    }
    for (const who of ["parley", "parleySupport"] as const) {
      expect(await call(who, method, path)).toEqual({ status: 403, body: { error: "FORBIDDEN" } });
    }
  });

  it("escribir la configuración es sólo de un admin de Betaso Games", async () => {
    for (const who of ["support", "parley", "parleySupport"] as const) {
      expect((await call(who, "DELETE", "/internal/settings/match")).status).toBe(403);
      expect((await call(who, "PATCH", "/internal/settings/match", {})).status).toBe(403);
    }
    expect((await call("games", "DELETE", "/internal/settings/match")).status).toBe(200);
  });

  it("las mesas son sólo del orquestador: ningún token de admin las abre", async () => {
    for (const who of ["games", "parley"] as const) {
      expect((await call(who, "GET", "/internal/census")).status).toBe(401);
    }
  });

  // EL CATÁLOGO TODAVÍA NO ACOTA POR OPERADOR, así que es de Betaso Games como todo lo demás.
  it("el catálogo administrativo es de Betaso Games mientras no acote por operador", async () => {
    expect((await call("parley", "GET", "/game-modes/admin")).status).toBe(403);
    expect((await call("support", "GET", "/game-modes/admin")).status).toBe(403);
    expect((await call("games", "GET", "/game-modes/admin")).status).toBe(200);
  });
});
