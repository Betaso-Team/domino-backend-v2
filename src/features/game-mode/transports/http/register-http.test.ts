import type { AddressInfo } from "node:net";
import type { Logger } from "@/logger";
import { httpErrorHandler } from "@/shared/http/error-handler";
import type { Lease } from "@/shared/mongo-lease";
import express, { type Application } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameModeRepository } from "../../core/catalog";
import type { GameMode } from "../../core/game-mode";
import { GameModeService } from "../../service";
import { MemoryGameModeOutbox } from "../memory-outbox";
import { MemoryGameModeRepository } from "../memory-repository";
import { BASE_INSTANT, clasica, mutableClock } from "../tests/repository-contract";
import { registerGameModeHttp } from "./register-http";

// LA FRONTERA MEDIDA CONTRA EL SERVICIO DE VERDAD y los adaptadores de memoria, no contra un doble
// del servicio. Es el mismo argumento de `service.test.ts`: `MemoryGameModeRepository` y
// `MemoryGameModeOutbox` son los que despliega la instancia sin `MONGO_URI`, así que medir contra
// ellos mide el sistema. Un doble con `create: vi.fn()` mediría que el handler llama al método que
// el propio test le enseñó a devolver, y lo que importa acá —el 409 del duplicado, el 409 de la baja
// repetida, el 404 del inactivo, el default que NO se pisa en un `PUT` parcial— nace del ida y
// vuelta entre los tres.
//
// Lo único que se escribe a mano son los desenlaces que ningún adaptador de memoria produce: el
// lease negado (503) y el repositorio que revienta (500).

const KEY = "k".repeat(16);
const SAME_LENGTH_KEY = "x".repeat(16);
const CREATED_AT = new Date(BASE_INSTANT).toISOString();

interface Response {
  readonly status: number;
  readonly body: unknown;
}

interface Harness {
  readonly repository: GameModeRepository;
  readonly outbox: MemoryGameModeOutbox;
  readonly logger: Logger;
  get(path: string, key?: string): Promise<Response>;
  post(path: string, body?: unknown, key?: string): Promise<Response>;
  put(path: string, body?: unknown, key?: string): Promise<Response>;
  del(path: string, key?: string): Promise<Response>;
}

function fakeLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function harness(
  over: {
    internalApiKey?: string | undefined;
    lease?: Lease;
    repository?: GameModeRepository;
  } = {},
): Harness {
  const clock = mutableClock();
  const repository = over.repository ?? new MemoryGameModeRepository(clock);
  const outbox = new MemoryGameModeOutbox(clock);
  const service = new GameModeService(
    repository,
    outbox,
    over.lease ?? {
      async within(_name, _ttlMs, work) {
        return work();
      },
    },
    vi.fn(),
  );
  const logger = fakeLogger();
  const app = express();
  // El orden de `app.config.ts`: el parser primero, las rutas después y el manejador de errores
  // último. Sin el manejador, un rechazo sin manejar devuelve la página HTML de Express y el test
  // del 500 mediría otra cosa.
  app.use(express.json());
  registerGameModeHttp(app, {
    service,
    logger,
    internalApiKey: "internalApiKey" in over ? over.internalApiKey : KEY,
  });
  app.use(httpErrorHandler(logger));

  const server = app.listen(0, "127.0.0.1");
  closers.push(() => server.close());
  const ready = new Promise<void>((resolve) => server.once("listening", () => resolve()));

  async function call(
    method: string,
    path: string,
    body: unknown,
    key: string | undefined,
  ): Promise<Response> {
    await ready;
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(key === undefined ? {} : { "X-Internal-Key": key }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    // Una ruta que no se registró contesta el HTML por defecto de Express, no JSON: el `catch`
    // es lo que deja que el caso "la mutación no existe" se mida por status.
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }

  return {
    repository,
    outbox,
    logger,
    get: (path, key) => call("GET", path, undefined, key),
    post: (path, body, key) => call("POST", path, body, key),
    put: (path, body, key) => call("PUT", path, body, key),
    del: (path, key) => call("DELETE", path, undefined, key),
  };
}

function wireDtoOf(mode: GameMode): Record<string, unknown> {
  return {
    _id: mode.id,
    uuid: mode.uuid,
    name: mode.name,
    multiplier: mode.multiplier,
    prize: mode.prize,
    entryFee: mode.entryFee,
    playersQuantity: mode.playersQuantity,
    pointsToWin: mode.pointsToWin,
    isActive: mode.isActive,
    isFreeRoom: mode.isFreeRoom,
    enableBots: mode.enableBots,
    createdAt: mode.createdAt.toISOString(),
    updatedAt: mode.updatedAt.toISOString(),
    __v: mode.version,
  };
}

// LAS CLAVES DE DEDUPLICACIÓN DE LO ENCOLADO, leídas por la ÚNICA ventana que el puerto tiene
// (`next` + `sent`), que es la misma que usa el despachador en producción. No hay inspector de
// "todas las entradas" a propósito — ver `transports/tests/outbox-contract.ts`.
async function drain(outbox: MemoryGameModeOutbox): Promise<string[]> {
  const keys: string[] = [];
  const later = new Date(BASE_INSTANT + 60_000);
  for (;;) {
    const entry = await outbox.next(later);
    if (!entry) return keys;
    keys.push(entry.dedupeKey);
    await outbox.sent(entry.id, later);
  }
}

// EL REGISTRO, MEDIDO SIN SERVIDOR. Lo que se mide acá es una decisión de wiring —qué rutas llegan a
// existir y EN QUÉ ORDEN—, y eso un servidor no lo muestra: dos órdenes distintos pueden responder
// igual hoy y dejar de hacerlo con la ruta que se agregue mañana.
function routesRegisteredWith(internalApiKey: string | undefined): string[] {
  const seen: string[] = [];
  const record = (method: string) => (path: string) => {
    seen.push(`${method} ${path}`);
  };
  const app = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    delete: record("DELETE"),
  } as unknown as Application;
  const clock = mutableClock();
  registerGameModeHttp(app, {
    service: new GameModeService(
      new MemoryGameModeRepository(clock),
      new MemoryGameModeOutbox(clock),
      {
        async within(_name, _ttlMs, work) {
          return work();
        },
      },
      vi.fn(),
    ),
    logger: fakeLogger(),
    internalApiKey,
  });
  return seen;
}

describe("registerGameModeHttp: las siete rutas", () => {
  // `reactive/:uuid` ANTES de `/:uuid`, y `sync` después del `POST` de la colección. Es el orden que
  // el plan pide y el que hay que conservar: hoy Express no confunde `/game-modes/reactive/x` con
  // `/game-modes/:uuid` —son dos segmentos contra uno—, pero una ruta futura con dos segmentos sí lo
  // haría, y este arreglo es lo único que lo dice.
  it("registra las siete rutas de v1 en orden", () => {
    expect(routesRegisteredWith(KEY)).toEqual([
      "GET /game-modes",
      "GET /game-modes/reactive/:uuid",
      "GET /game-modes/:uuid",
      "POST /game-modes",
      "PUT /game-modes/:uuid",
      "POST /game-modes/sync",
      "DELETE /game-modes/:uuid",
    ]);
  });

  // FAIL CLOSED, y es la decisión del incremento: el panel no autentica administradores contra
  // domino, así que sin llave no hay quién valide al admin. Una mutación que configura dinero real
  // y contesta sin credencial es peor que una funcionalidad ausente.
  it("sin llave interna sólo quedan los dos GET públicos", () => {
    expect(routesRegisteredWith(undefined)).toEqual(["GET /game-modes", "GET /game-modes/:uuid"]);
  });

  it("sin llave interna avisa nombrando las rutas que no se registraron", () => {
    const logger = fakeLogger();
    const app = {
      get: () => undefined,
      post: () => undefined,
      put: () => undefined,
      delete: () => undefined,
    } as unknown as Application;
    const clock = mutableClock();

    registerGameModeHttp(app, {
      service: new GameModeService(
        new MemoryGameModeRepository(clock),
        new MemoryGameModeOutbox(clock),
        {
          async within(_name, _ttlMs, work) {
            return work();
          },
        },
        vi.fn(),
      ),
      logger,
      internalApiKey: undefined,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("/game-modes"));
  });

  it.each([
    ["POST", "/game-modes"],
    ["PUT", "/game-modes/mode-1"],
    ["POST", "/game-modes/sync"],
    ["DELETE", "/game-modes/mode-1"],
    ["GET", "/game-modes/reactive/mode-1"],
  ])("sin llave interna %s %s no existe", async (method, path) => {
    const app = harness({ internalApiKey: undefined });

    const response =
      method === "GET"
        ? await app.get(path, KEY)
        : method === "DELETE"
          ? await app.del(path, KEY)
          : method === "PUT"
            ? await app.put(path, {}, KEY)
            : await app.post(path, {}, KEY);

    expect(response.status).toBe(404);
  });
});

describe("GET /game-modes", () => {
  it("devuelve el DTO de v1 completo, sin llave y con el envelope histórico", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    expect(await app.get("/game-modes")).toEqual({
      status: 200,
      body: {
        status: "success",
        data: [
          {
            _id: seeded.id,
            uuid: seeded.uuid,
            name: "Clásica",
            multiplier: 1,
            prize: 18,
            entryFee: 10,
            playersQuantity: 2,
            pointsToWin: 25,
            isActive: true,
            isFreeRoom: false,
            enableBots: false,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            __v: 0,
          },
        ],
      },
    });
  });

  it("no lista los modos dados de baja", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());
    await app.repository.update(seeded.uuid, { isActive: false });

    expect(await app.get("/game-modes")).toEqual({
      status: 200,
      body: { status: "success", data: [] },
    });
  });
});

describe("GET /game-modes/:uuid", () => {
  it("devuelve el modo activo sin llave", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    expect(await app.get(`/game-modes/${seeded.uuid}`)).toEqual({
      status: 200,
      body: { status: "success", data: wireDtoOf(seeded) },
    });
  });

  it.each([
    ["inexistente", undefined],
    ["dado de baja", false],
  ])("contesta 404 con el mensaje de v1 si el modo es %s", async (_label, deactivate) => {
    const app = harness();
    let uuid = "no-existe";
    if (deactivate === false) {
      const seeded = await app.repository.create(clasica());
      await app.repository.update(seeded.uuid, { isActive: false });
      uuid = seeded.uuid;
    }

    expect(await app.get(`/game-modes/${uuid}`)).toEqual({
      status: 404,
      body: { status: "error", message: "Modo de juego no encontrado" },
    });
  });
});

describe("POST /game-modes", () => {
  const body = { name: "Clásica", prize: 18, entryFee: 10, playersQuantity: 2 };

  it("crea con 201 y devuelve el DTO de v1", async () => {
    const app = harness();

    const response = await app.post("/game-modes", body, KEY);

    expect(response.status).toBe(201);
    const created = (await app.repository.all())[0] as GameMode;
    expect(response.body).toEqual({ status: "success", data: wireDtoOf(created) });
    expect(created.name).toBe("Clásica");
  });

  // `playersQuantity` llega como número o como string porque Mongoose coercionaba y el DTO histórico
  // declaraba `z.enum(["2","4"])`.
  it.each([
    [2, 2],
    ["2", 2],
    [4, 4],
    ["4", 4],
  ])("acepta playersQuantity %p", async (input, expected) => {
    const app = harness();

    const response = await app.post("/game-modes", { ...body, playersQuantity: input }, KEY);

    expect(response.status).toBe(201);
    expect((response.body as { data: { playersQuantity: number } }).data.playersQuantity).toBe(
      expected,
    );
  });

  // EL BUG DE v1 QUE NO SE PORTA: allá el `enableBots` del cuerpo se perdía en la desestructuración
  // (`Betaso-Domino-Backend/src/game-modes/routes.ts:92-93`), así que el panel no podía encenderlos
  // en una mesa de dos ni apagarlos en una de cuatro. El default de una mesa de dos es `false`, así
  // que este `true` sólo puede venir del cuerpo.
  it("deja viajar enableBots hasta el modo persistido", async () => {
    const app = harness();

    const response = await app.post("/game-modes", { ...body, enableBots: true }, KEY);

    expect((response.body as { data: { enableBots: boolean } }).data.enableBots).toBe(true);
  });

  // EL DEFAULT DE `enableBots` DEPENDE DE OTRO CAMPO (`playersQuantity === 4`,
  // `game-mode.schema.ts:66-71`) y lo completa el REPOSITORIO. Si la frontera le pusiera un default
  // fijo, toda mesa de cuatro nacería con los bots apagados y nadie habría escrito ese valor.
  it("no le pone default a enableBots: una mesa de cuatro nace con los bots encendidos", async () => {
    const app = harness();

    const response = await app.post("/game-modes", { ...body, playersQuantity: 4 }, KEY);

    expect((response.body as { data: { enableBots: boolean } }).data.enableBots).toBe(true);
  });

  // v1 acepta el campo y lo pisa con `true` (`game-mode.service.ts:64-69`): un modo nace activo.
  it("acepta el isActive histórico pero fuerza true", async () => {
    const app = harness();

    const response = await app.post("/game-modes", { ...body, isActive: false }, KEY);

    expect((response.body as { data: { isActive: boolean } }).data.isActive).toBe(true);
  });

  it("contesta 409 ante el par nombre + cantidad repetido", async () => {
    const app = harness();
    await app.repository.create(clasica());

    const response = await app.post("/game-modes", body, KEY);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ status: "error" });
  });

  // v1 NO contestaba 400 nunca: sus rutas no llaman al `.parse()` de su propio DTO, así que un
  // cuerpo inválido moría en la validación de Mongoose y salía como 500. Esto es una MEJORA
  // deliberada, no compatibilidad.
  it.each([
    ["sin nombre", { prize: 18, entryFee: 10, playersQuantity: 2 }],
    ["con cantidad imposible", { ...body, playersQuantity: 3 }],
    ["con un monto inseguro", { ...body, entryFee: 2 ** 53 }],
    ["con un campo desconocido", { ...body, createdBy: "admin" }],
  ])("contesta 400 %s", async (_label, invalid) => {
    const app = harness();

    const response = await app.post("/game-modes", invalid, KEY);

    expect(response.status).toBe(400);
    expect(await app.repository.all()).toEqual([]);
  });
});

describe("PUT /game-modes/:uuid", () => {
  it("edita y devuelve el DTO con la revisión avanzada", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    const response = await app.put(`/game-modes/${seeded.uuid}`, { prize: 20 }, KEY);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "success",
      data: { prize: 20, __v: 1, _id: seeded.id, uuid: seeded.uuid },
    });
  });

  // ⚠ EL DEFECTO QUE ESTE TEST EXISTE PARA ATRAPAR. Con el `UPDATE_BODY` escrito como `.partial()`
  // del cuerpo de creación, zod 4 SIGUE aplicando los defaults a los campos ausentes, y un `PUT` que
  // sólo cambia el premio le reescribe al modo el multiplicador, los puntos y la sala gratis con los
  // valores de fábrica. Es una edición destructiva silenciosa sobre un modo con dinero configurado.
  it("un PUT parcial no pisa los campos que no viajaron", async () => {
    const app = harness();
    const seeded = await app.repository.create(
      clasica({ multiplier: 3, pointsToWin: 50, isFreeRoom: true, enableBots: true }),
    );

    const response = await app.put(`/game-modes/${seeded.uuid}`, { prize: 20 }, KEY);

    expect(response.body).toMatchObject({
      data: { prize: 20, multiplier: 3, pointsToWin: 50, isFreeRoom: true, enableBots: true },
    });
  });

  it("contesta 404 sobre un uuid inexistente", async () => {
    const app = harness();

    expect(await app.put("/game-modes/no-existe", { prize: 20 }, KEY)).toEqual({
      status: 404,
      body: { status: "error", message: "Modo de juego no encontrado" },
    });
  });

  it("contesta 400 ante un cuerpo inválido", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    const response = await app.put(`/game-modes/${seeded.uuid}`, { prize: -1 }, KEY);

    expect(response.status).toBe(400);
  });
});

describe("DELETE /game-modes/:uuid", () => {
  it("da de baja con el mensaje histórico y sin data", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    expect(await app.del(`/game-modes/${seeded.uuid}`, KEY)).toEqual({
      status: 200,
      body: { status: "success", message: "Modo de juego eliminado correctamente" },
    });
    expect((await app.repository.byUuid(seeded.uuid))?.isActive).toBe(false);
  });

  // 409 Y NO 404, y es la mejora que la Tarea 8 preparó con su cuarto error: el modo EXISTE y el
  // panel lo está viendo listado. v1 contestaba 500 acá —su servicio lanzaba «El modo ya está
  // inactivo» y la ruta lo tragaba en el catch genérico (`routes.ts:172-178`)—, así que el operador
  // no tenía cómo distinguir "ya estaba dado de baja" de "se cayó la base".
  it("contesta 409 si el modo ya estaba dado de baja", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());
    await app.del(`/game-modes/${seeded.uuid}`, KEY);

    const response = await app.del(`/game-modes/${seeded.uuid}`, KEY);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ status: "error" });
  });

  it("contesta 404 sobre un uuid inexistente", async () => {
    const app = harness();

    expect(await app.del("/game-modes/no-existe", KEY)).toEqual({
      status: 404,
      body: { status: "error", message: "Modo de juego no encontrado" },
    });
  });
});

describe("GET /game-modes/reactive/:uuid", () => {
  it("reactiva con el mensaje histórico", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());
    await app.repository.update(seeded.uuid, { isActive: false });

    expect(await app.get(`/game-modes/reactive/${seeded.uuid}`, KEY)).toEqual({
      status: 200,
      body: { status: "success", message: "Modo de juego reactivado correctamente" },
    });
    expect((await app.repository.byUuid(seeded.uuid))?.isActive).toBe(true);
  });

  it("contesta 409 si el modo ya estaba activo", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    expect((await app.get(`/game-modes/reactive/${seeded.uuid}`, KEY)).status).toBe(409);
  });

  it("contesta 404 sobre un uuid inexistente", async () => {
    const app = harness();

    expect(await app.get("/game-modes/reactive/no-existe", KEY)).toEqual({
      status: 404,
      body: { status: "error", message: "Modo de juego no encontrado" },
    });
  });
});

describe("POST /game-modes/sync", () => {
  // El número es el de ENCOLADOS y cuenta los inactivos, igual que el `/sync` de v1 que consulta
  // `getAll()` (`game-mode.service.ts:177-178`).
  it("devuelve cuántos modos encoló", async () => {
    const app = harness();
    const primero = await app.repository.create(clasica());
    await app.repository.create(clasica({ name: "Cuarteto", playersQuantity: 4 }));
    await app.repository.update(primero.uuid, { isActive: false });

    expect(await app.post("/game-modes/sync", undefined, KEY)).toEqual({
      status: 200,
      body: { status: "success", data: { synced: 2 } },
    });
  });

  // CADA REQUEST LLEVA SU PROPIO LOTE, y el número de la respuesta NO alcanza para medirlo: `sync`
  // devuelve los modos RECORRIDOS y no los insertados, así que un `batchId` fijo contestaría
  // `{ synced: 1 }` las dos veces sin haber encolado nada la segunda —el botón de recuperación
  // apretado por segunda vez, contestando éxito y sin publicar—. Lo que lo mide es el outbox: la
  // clave de deduplicación del lote es `["game_mode.sync", batchId, uuid]`, así que dos lotes
  // distintos son dos entradas.
  it("dos llamadas encolan dos lotes distintos", async () => {
    const app = harness();
    await app.repository.create(clasica());

    await app.post("/game-modes/sync", undefined, KEY);
    await app.post("/game-modes/sync", undefined, KEY);

    const syncs = (await drain(app.outbox)).filter((key) => key.includes("game_mode.sync"));
    expect(syncs).toHaveLength(2);
    expect(new Set(syncs).size).toBe(2);
  });
});

describe("la llave interna", () => {
  const mutations: Array<[string, string]> = [
    ["POST", "/game-modes"],
    ["PUT", "/game-modes/mode-1"],
    ["POST", "/game-modes/sync"],
    ["DELETE", "/game-modes/mode-1"],
    ["GET", "/game-modes/reactive/mode-1"],
  ];

  async function callWith(app: Harness, method: string, path: string, key?: string) {
    if (method === "GET") return app.get(path, key);
    if (method === "DELETE") return app.del(path, key);
    if (method === "PUT") return app.put(path, {}, key);
    return app.post(path, {}, key);
  }

  it.each(mutations)("%s %s contesta 401 sin llave", async (method, path) => {
    const app = harness();

    expect(await callWith(app, method, path)).toEqual({
      status: 401,
      body: { error: "UNAUTHORIZED" },
    });
  });

  // LAS DOS FORMAS DE LLAVE EQUIVOCADA, y la del LARGO DISTINTO es la que importa: `timingSafeEqual`
  // LANZA si los dos buffers no miden lo mismo, así que una comparación que no guarde el largo
  // primero contestaría 500 en vez de 401 —y un 500 distinguible es exactamente el oráculo que una
  // comparación constante existe para no dar—. Ver `shared/http/internal-key.ts`.
  it.each(mutations)("%s %s contesta 401 con una llave equivocada", async (method, path) => {
    const app = harness();

    expect((await callWith(app, method, path, SAME_LENGTH_KEY)).status).toBe(401);
    expect((await callWith(app, method, path, "corta")).status).toBe(401);
  });

  // La credencial se pide ANTES de mirar el cuerpo: al revés, un anónimo distingue "forma inválida"
  // de "forma válida" en una ruta que no tiene derecho a tocar.
  it("no filtra la validación del cuerpo a quien no trae llave", async () => {
    const app = harness();

    expect((await app.post("/game-modes", { prize: "no es un número" })).status).toBe(401);
  });

  it("los dos GET públicos no piden llave", async () => {
    const app = harness();
    const seeded = await app.repository.create(clasica());

    expect((await app.get("/game-modes")).status).toBe(200);
    expect((await app.get(`/game-modes/${seeded.uuid}`)).status).toBe(200);
  });
});

describe("la infraestructura administrativa", () => {
  // EL LEASE NO CONSEGUIDO ES 503 Y NO 500: lo tiene otro proceso, nadie hizo nada mal y reintentar
  // es la respuesta correcta.
  it.each([
    ["POST", "/game-modes"],
    ["PUT", "/game-modes/mode-1"],
    ["DELETE", "/game-modes/mode-1"],
    ["GET", "/game-modes/reactive/mode-1"],
    // EL `/sync` TAMBIÉN, y es el que se olvidaba: va adentro del lease aunque no toque el catálogo
    // —escribe el outbox—, así que el operador que aprieta "republicar todo" mientras otro proceso
    // edita tiene que leer "reintentá" y no una caída.
    ["POST", "/game-modes/sync"],
  ])("%s %s contesta 503 si el catálogo está ocupado", async (method, path) => {
    const app = harness({
      lease: {
        async within() {
          return undefined;
        },
      },
    });

    const response =
      method === "DELETE"
        ? await app.del(path, KEY)
        : method === "GET"
          ? await app.get(path, KEY)
          : method === "PUT"
            ? await app.put(path, { prize: 20 }, KEY)
            : await app.post(
                path,
                { name: "Clásica", prize: 18, entryFee: 10, playersQuantity: 2 },
                KEY,
              );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: "error" });
  });

  // UN FALLO DESCONOCIDO NO SE DISFRAZA DE 404. Traducirlo acá le diría al panel que el modo no
  // existe cuando lo que pasa es que la base no contesta, y el operador iría a auditar el modo
  // equivocado. Sale por el manejador de errores compartido, que loguea el stack y contesta 500.
  it("un fallo del repositorio sale como 500 y no como 404", async () => {
    const boom = () => Promise.reject(new Error("mongo caído"));
    const app = harness({
      repository: {
        active: boom,
        all: boom,
        activeByUuid: boom,
        byUuid: boom,
        create: boom,
        update: boom,
      } as unknown as GameModeRepository,
    });

    expect(await app.get("/game-modes")).toEqual({ status: 500, body: { error: "INTERNAL" } });
  });
});
