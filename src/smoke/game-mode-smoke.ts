import assert from "node:assert/strict";
import { MongoClient } from "mongodb";
import { env } from "../env.js";
import { logger } from "../logger.js";

// LA CERTIFICACIÓN DEL CATÁLOGO CONTRA SERVICIOS DE VERDAD, y es lo único de este incremento que
// ninguna suite puede reemplazar. Los adaptadores se miden con dobles del driver —correcto, porque
// `npm test` no debe depender de nada externo— pero un doble acepta el documento que le demos.
// Mongo acepta el que Mongo acepta.
//
// Se mide contra las DOS instancias de pm2: el catálogo vive en Mongo, así que las dos tienen que
// contestar lo mismo. Si alguien lo volviera a poner en memoria, cada una contestaría lo suyo y
// nadie se enteraría hasta producción.

const HTTP = "http://nginx:8080";
const KEY = env.internalApiKey ?? "";
const PLAZO_MS = 10_000;

const MODO = { name: "smoke-catalogo", playersQuantity: 2, entryFee: 10, prize: 18 } as const;

interface Sobre {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function pedir(
  método: string,
  ruta: string,
  { body, key }: { body?: unknown; key?: string } = {},
): Promise<Sobre> {
  const response = await fetch(`${HTTP}${ruta}`, {
    method: método,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key === undefined ? {} : { "X-Internal-Key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// UN PLAZO EXPLÍCITO POR ESPERA, y ningún `sleep` ciego decide éxito. Un sleep fijo pasa en una
// máquina rápida y se pone rojo en el CI sin decir qué no llegó; esto falla NOMBRANDO lo que
// esperaba. `null` cuenta como "todavía no" igual que `undefined`: es lo que devuelve el `findOne`
// del driver cuando no encontró, o sea la condición de reintento de casi todas las esperas de acá.
async function esperarHasta<T>(
  qué: string,
  intento: () => Promise<T | undefined | null>,
  plazoMs = PLAZO_MS,
): Promise<T> {
  const límite = Date.now() + plazoMs;
  let último: unknown;
  while (Date.now() < límite) {
    try {
      const valor = await intento();
      if (valor !== undefined && valor !== null) return valor;
    } catch (error) {
      último = error;
    }
    await new Promise((resolver) => setTimeout(resolver, 200));
  }
  throw new Error(`no llegó en ${plazoMs} ms: ${qué}${último ? ` — último error: ${último}` : ""}`);
}

async function conMongo<T>(trabajo: (db: import("mongodb").Db) => Promise<T>): Promise<T> {
  assert.ok(env.mongoUri, "el cliente smoke necesita MONGO_URI para asertar por fuera de HTTP");
  const client = new MongoClient(env.mongoUri);
  try {
    await client.connect();
    return await trabajo(client.db());
  } finally {
    await client.close();
  }
}

async function certificarCatálogo(): Promise<void> {
  // ESPERAR AL SERVIDOR ACÁ Y NO EN EL RUNNER: la fase sabe qué necesita, y el runner queda tonto.
  // Se espera `/ready` y no `/health` —`/health` no consulta nada a propósito— porque lo que hace
  // falta es que Mongo esté atendiendo, no que el proceso exista. El plazo es largo porque incluye
  // el arranque de pm2 con dos instancias.
  await esperarHasta(
    "/ready de la instancia base",
    async () => {
      const response = await fetch(`${HTTP}/ready`);
      return response.status === 200 ? true : undefined;
    },
    60_000,
  );

  const creado = await pedir("POST", "/game-modes", { body: MODO, key: KEY });
  assert.equal(creado.status, 201, `POST /game-modes contestó ${creado.status}`);
  assert.equal(creado.body.status, "success");
  const dto = creado.body.data as Record<string, unknown>;
  const uuid = dto.uuid as string;

  // EL DTO DE v1 ENTERO, comparado por su juego de claves y no campo por campo: lo que hay que
  // cazar es un campo de MENOS (el panel deja de verlo) o uno de MÁS (una fuga de nombre interno).
  assert.deepStrictEqual(
    Object.keys(dto).sort(),
    [
      "__v",
      "_id",
      "createdAt",
      "enableBots",
      "entryFee",
      "isActive",
      "isFreeRoom",
      "multiplier",
      "name",
      "playersQuantity",
      "pointsToWin",
      "prize",
      "updatedAt",
      "uuid",
    ],
    "el DTO de v1 cambió de forma",
  );
  assert.equal(dto.entryFee, 10, "el monto NO se escala: 10 son 10 UC");
  assert.equal(dto.prize, 18);
  assert.equal(dto.multiplier, 1, "default del schema de v1");
  assert.equal(dto.pointsToWin, 25, "default del schema de v1, no el 25 del DTO muerto");
  assert.equal(dto.isFreeRoom, false);
  assert.equal(dto.enableBots, false, "2P no habilita bots");
  assert.equal(dto.isActive, true);
  assert.equal(dto.__v, 0);

  // LO QUE MONGO GUARDÓ DE VERDAD, que es lo único que un doble del driver no puede certificar.
  await conMongo(async (db) => {
    const documento = await esperarHasta("el modo en game_modes_domino", () =>
      db.collection("game_modes_domino").findOne({ uuid }),
    );
    assert.ok(documento.createdAt instanceof Date, "createdAt tiene que ser Date y no string");
    assert.ok(documento.updatedAt instanceof Date);
    assert.equal(typeof documento.__v, "number");
    assert.equal(documento.entryFee, 10);
    assert.equal(documento.playersQuantity, 2);

    const índices = await db.collection("game_modes_domino").indexes();
    const nombres = índices.map((índice) => índice.name).sort();
    for (const esperado of ["uuid_1", "isActive_1", "isActive_1_name_1", "isActive_1_uuid_1"])
      assert.ok(nombres.includes(esperado), `falta el índice ${esperado} — están: ${nombres}`);
    const único = índices.find((índice) => índice.name === "uuid_1");
    assert.equal(único?.unique, true, "uuid_1 tiene que ser único");
  });

  // LAS MUTACIONES QUE FALTAN, cada una con su envelope.
  const editado = await pedir("PUT", `/game-modes/${uuid}`, { body: { prize: 20 }, key: KEY });
  assert.equal(editado.status, 200);
  assert.equal((editado.body.data as Record<string, unknown>).prize, 20);
  assert.equal(
    (editado.body.data as Record<string, unknown>).pointsToWin,
    25,
    "un PUT parcial NO puede reescribir lo que no nombró",
  );

  const borrado = await pedir("DELETE", `/game-modes/${uuid}`, { key: KEY });
  assert.equal(borrado.status, 200);
  assert.equal(borrado.body.message, "Modo de juego eliminado correctamente");

  // DADO DE BAJA NO EXISTE desde afuera: el GET público tiene que contestar 404 antes de reactivar.
  const oculto = await pedir("GET", `/game-modes/${uuid}`);
  assert.equal(oculto.status, 404, "un modo inactivo no puede seguir siendo elegible");

  const reactivado = await pedir("GET", `/game-modes/reactive/${uuid}`, { key: KEY });
  assert.equal(reactivado.status, 200);
  assert.equal(reactivado.body.message, "Modo de juego reactivado correctamente");

  const listado = await pedir("GET", "/game-modes");
  assert.equal(listado.status, 200, "el GET del catálogo es PÚBLICO y no pide llave");
  assert.ok(
    (listado.body.data as readonly { uuid: string }[]).some((modo) => modo.uuid === uuid),
    "el modo reactivado tiene que volver al listado público",
  );

  // LAS DOS INSTANCIAS PM2 SIRVEN EL MISMO CATÁLOGO, con la MISMA revisión.
  for (const puerto of [2567, 2568]) {
    const porPuerto = await esperarHasta(`el catálogo por el puerto ${puerto}`, async () => {
      const response = await pedir("GET", `/${puerto}/game-modes`);
      return response.status === 200 ? response : undefined;
    });
    const modos = porPuerto.body.data as readonly { uuid: string; prize: number }[];
    const encontrado = modos.find((candidato) => candidato.uuid === uuid);
    assert.ok(encontrado, `la instancia ${puerto} no ve el modo del catálogo compartido`);
    assert.equal(
      encontrado.prize,
      20,
      `la instancia ${puerto} contesta una revisión vieja: el catálogo no es compartido`,
    );
  }

  logger.info("smoke game-mode: catálogo ok", { uuid });
}

async function run(): Promise<void> {
  assert.equal(env.runEngineSmoke, true, "game-mode-smoke exige RUN_ENGINE_SMOKE=1");
  assert.ok(KEY, "el cliente smoke necesita INTERNAL_API_KEY para las mutaciones");
  await certificarCatálogo();
}

run()
  .catch((error) => {
    logger.error("smoke game-mode: falló", { error: String(error) });
    process.exitCode = 1;
  })
  // SE SALE EXPLÍCITAMENTE, por lo mismo que `engine-smoke.ts`: una conexión de Mongo que quedó
  // abierta por un camino de error sostiene el event loop, y una fase colgada es un runner colgado
  // — en verde y sin decir nada. Ver el comentario largo en el otro archivo.
  .finally(() => process.exit(process.exitCode ?? 0));
