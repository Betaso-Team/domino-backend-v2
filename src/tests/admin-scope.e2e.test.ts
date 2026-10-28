import { env } from "@/env";
import { mintAdminToken, mintLegacyAdminToken } from "@/tests/billing-auth-keys";
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
  legacy: mintLegacyAdminToken("viejo"),
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
    for (const who of ["games", "support", "key"] as const) {
      expect([200, 404]).toContain((await call(who, method, path)).status);
    }
    // UN TOKEN SIN `prv` NI `role` NO ENTRA: sin tolerancia a los tokens de antes de los operadores.
    expect(await call("legacy", method, path)).toEqual({
      status: 401,
      body: { error: "UNAUTHORIZED" },
    });
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
      expect((await call(who, "GET", "/internal/game-modes")).status).toBe(401);
    }
    expect((await call("key", "GET", "/internal/game-modes")).status).toBe(401);
  });

  // EL CATÁLOGO, CON EL OPERADOR DENTRO DE SU ÁMBITO: crea su modo propio, que no sale al público y
  // que el orquestador ve con su dueño; el otro operador ni lo ve.
  it("un operador crea un modo propio que sólo ven él, Betaso Games y el orquestador", async () => {
    const created = await call("parley", "POST", "/game-modes", {
      name: "Clásica de Parley",
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
    });
    expect(created.status).toBe(201);
    const mode = (created.body as { data: Record<string, unknown> }).data;
    expect(mode).toMatchObject({ ownerProviderId: "parley" });
    // UN OPERADOR NO VE LISTAS DE SUSCRIPTORES, ni siquiera la (vacía) de su propio modo.
    expect(mode).not.toHaveProperty("subscribers");
    const uuid = mode.uuid as string;

    const publico = (await call("parley", "GET", "/game-modes")).body as {
      data: Array<{ uuid: string }>;
    };
    expect(publico.data.map((m) => m.uuid)).not.toContain(uuid);
    expect((await call("parley", "GET", `/game-modes/${uuid}`)).status).toBe(404);

    expect((await call("rival", "GET", `/game-modes/admin/${uuid}`)).status).toBe(404);
    expect((await call("rival", "PUT", `/game-modes/${uuid}`, { prize: 1 })).status).toBe(404);
    expect((await call("parleySupport", "GET", `/game-modes/admin/${uuid}`)).status).toBe(200);
    expect((await call("parleySupport", "PUT", `/game-modes/${uuid}`, { prize: 1 })).status).toBe(
      403,
    );
    expect((await call("games", "GET", `/game-modes/admin/${uuid}`)).body).toMatchObject({
      data: { uuid, ownerProviderId: "parley", subscribers: [] },
    });

    const internal = (await call("orchestrator", "GET", "/internal/game-modes")).body as {
      data: Array<{ uuid: string; ownerProviderId: string | null }>;
    };
    expect(internal.data.find((m) => m.uuid === uuid)).toMatchObject({
      ownerProviderId: "parley",
      subscribers: [],
    });
  });

  it("un operador se suscribe a sí mismo y no edita un compartido", async () => {
    const created = await call("games", "POST", "/game-modes", {
      name: "Compartida e2e",
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
    });
    const uuid = (created.body as { data: { uuid: string } }).data.uuid;

    expect((await call("support", "PUT", `/game-modes/${uuid}/subscriptions/parley`)).status).toBe(
      403,
    );
    // Parley se suscribe a sí mismo; el compartido no lo edita.
    expect((await call("parley", "PUT", `/game-modes/${uuid}/subscriptions/parley`)).status).toBe(
      200,
    );
    expect((await call("parley", "PUT", `/game-modes/${uuid}/subscriptions/rival`)).status).toBe(
      403,
    );
    expect((await call("parley", "PUT", `/game-modes/${uuid}`, { prize: 1 })).status).toBe(403);
    expect((await call("games", "GET", `/game-modes/admin/${uuid}`)).body).toMatchObject({
      data: { subscribers: ["parley"] },
    });
  });

  // LA FUENTE `own` DE PUNTA A PUNTA: pasar exige un propio activo, y con la fuente en `own` el último
  // propio activo no se da de baja hasta volver a `shared`.
  it("la fuente `own` protege el último modo propio activo", async () => {
    expect(
      (await call("rival", "PUT", "/game-modes/catalogs/rival", { source: "own" })).status,
    ).toBe(409);
    const created = await call("rival", "POST", "/game-modes", {
      name: "Único del rival e2e",
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
    });
    const uuid = (created.body as { data: { uuid: string } }).data.uuid;
    expect(
      (await call("rival", "PUT", "/game-modes/catalogs/rival", { source: "own" })).status,
    ).toBe(200);

    const baja = await call("rival", "DELETE", `/game-modes/${uuid}`);
    expect(baja.status).toBe(409);
    expect((baja.body as { message: string }).message).toContain("shared");
    expect((await call("rival", "PUT", `/game-modes/${uuid}`, { isActive: false })).status).toBe(
      409,
    );

    expect(
      (await call("rival", "PUT", "/game-modes/catalogs/rival", { source: "shared" })).status,
    ).toBe(200);
    expect((await call("rival", "DELETE", `/game-modes/${uuid}`)).status).toBe(200);
  });
});
