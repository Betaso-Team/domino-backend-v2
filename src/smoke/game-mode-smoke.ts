import assert from "node:assert/strict";
import { env } from "@/env";
import { logger } from "@/logger";
import { connect } from "amqplib";
import { MongoClient } from "mongodb";

// LA CERTIFICACIÓN DEL CATÁLOGO CONTRA SERVICIOS DE VERDAD, y es lo único de este incremento que
// ninguna suite puede reemplazar. Los adaptadores se miden con dobles del driver —correcto, porque
// `npm test` no debe depender de nada externo— pero un doble acepta el documento que le demos.
// Mongo acepta el que Mongo acepta, y el consumidor recibe el cuerpo que salió por el cable.
//
// TRES FASES, EJECUTABLES POR ARGUMENTO, y están separadas porque entre una y otra el runner APAGA
// Y PRENDE RabbitMQ. No es un `describe` con tres `it`: el estado que las une es el broker del
// compose, no una variable de este proceso.
//
//   · `normal`  — el catálogo entero con todo arriba.
//   · `enqueue` — con el broker CAÍDO: la mutación contesta OK igual y el evento queda PENDING.
//   · `recover` — con el broker de vuelta: lo pendiente sale solo, y el reconciliador cierra una
//                 ventana rota a mano.
//
// SE COORDINAN POR EL ESTADO DURABLE DE MONGO y no por archivos temporales del host: el modo que
// `normal` deja activo es el que `enqueue` edita y el que `recover` encuentra. Un archivo del host
// no sobreviviría a `compose run --rm` y además mentiría si una fase quedó a medias.

const HTTP = "http://nginx:8080";
const KEY = env.internalApiKey ?? "";
const EXCHANGE = "betaso";
// LA COLA ES DURABLE Y CON NOMBRE, y se declara ANTES de la primera mutación. Un topic exchange
// DESCARTA lo que no matchea ninguna binding: sin la cola puesta primero, el `game_mode.created`
// se publicaría contra nadie y la fase `recover` esperaría para siempre un mensaje que nunca
// existió. Es el error más fácil de cometer acá y el más difícil de diagnosticar, porque el
// publicador recibe su confirm igual — el broker confirma que lo ACEPTÓ, no que alguien lo guardó.
const QUEUE = "smoke-game-mode";
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
// esperaba, que es la diferencia entre diagnosticar y volver a correrlo a ver si pasa.
// `null` CUENTA COMO "TODAVÍA NO", igual que `undefined`: el `findOne` del driver devuelve `null`
// cuando no encontró, que es exactamente la condición de reintento de casi todas las esperas de
// este archivo. Tratarlo como un valor haría que la espera resolviera con nada y la aserción
// siguiente explotara con un `null` en vez de decir QUÉ no llegó.
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FASE `normal`
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function declararCola(): Promise<void> {
  assert.ok(env.rabbitmqUrl, "el cliente smoke necesita RABBITMQ_URL");
  const connection = await connect(env.rabbitmqUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, "game_mode.*");
  await channel.close();
  await connection.close();
}

// SE DRENA LA COLA, no se consume un mensaje: lo que hay que comparar es el CUERPO, y devolverlos
// todos deja que el llamador afirme cuál esperaba sin depender del orden en que el despachador los
// haya sacado. Se hace `ack` de lo que se saca porque la cola es durable y sobrevive entre fases.
async function drenarCola(mínimo: number): Promise<readonly Record<string, unknown>[]> {
  assert.ok(env.rabbitmqUrl, "el cliente smoke necesita RABBITMQ_URL");
  const connection = await connect(env.rabbitmqUrl);
  const channel = await connection.createChannel();
  const mensajes: Record<string, unknown>[] = [];
  try {
    await esperarHasta(`${mínimo} mensaje(s) en ${QUEUE}`, async () => {
      for (;;) {
        const mensaje = await channel.get(QUEUE, { noAck: false });
        if (mensaje === false) break;
        mensajes.push(JSON.parse(mensaje.content.toString()) as Record<string, unknown>);
        channel.ack(mensaje);
      }
      return mensajes.length >= mínimo ? mensajes : undefined;
    });
  } finally {
    await channel.close();
    await connection.close();
  }
  return mensajes;
}

async function normal(): Promise<void> {
  // ESPERAR AL SERVIDOR ACÁ Y NO EN EL RUNNER: la fase sabe qué necesita, y el runner queda tonto.
  // Se espera `/ready` y no `/health` —`/health` no consulta nada a propósito— porque lo que hace
  // falta es que Mongo y Rabbit estén atendiendo, no que el proceso exista. El plazo es largo
  // porque incluye el arranque de pm2 con dos instancias.
  await esperarHasta(
    "/ready de la instancia base",
    async () => {
      const response = await fetch(`${HTTP}/ready`);
      return response.status === 200 ? true : undefined;
    },
    60_000,
  );

  // PRIMERO LA COLA. Ver el comentario de `QUEUE`: al revés el `created` se publica contra nadie.
  await declararCola();

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

  // EL CUERPO PUBLICADO, COMPARADO CAMPO POR CAMPO contra el de v1. `deepStrictEqual` y no un
  // `objectContaining`: lo que hay que medir es que NO viajen `isFreeRoom` ni `enableBots`, y una
  // aserción parcial no puede ver un campo de más.
  const [created] = await drenarCola(1);
  assert.deepStrictEqual(
    created,
    {
      id: uuid,
      game: "domino",
      name: MODO.name,
      isActive: true,
      prize: 18,
      entryFee: 10,
      multiplier: 1,
      pointsToWin: 25,
      playerCount: 2,
    },
    "el payload de game_mode.created dejó de ser el de v1",
  );

  // LAS MUTACIONES QUE FALTAN, cada una con su envelope y su evento.
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

  const reactivado = await pedir("GET", `/game-modes/reactive/${uuid}`, { key: KEY });
  assert.equal(reactivado.status, 200);
  assert.equal(reactivado.body.message, "Modo de juego reactivado correctamente");

  const sincronizado = await pedir("POST", "/game-modes/sync", { key: KEY });
  assert.equal(sincronizado.status, 200);
  assert.ok(
    (sincronizado.body.data as { synced: number }).synced >= 1,
    "sync tiene que reportar al menos el modo del smoke",
  );

  // CUATRO `updated` MÁS: edición, baja, reactivación y el lote forzado.
  const posteriores = await drenarCola(4);
  for (const evento of posteriores)
    assert.equal(evento.id, uuid, "un evento del catálogo salió con otro id");
  assert.ok(
    posteriores.some((evento) => evento.isActive === false),
    "la baja tiene que viajar como updated con isActive false",
  );
  assert.ok(
    posteriores.some((evento) => evento.prize === 20),
    "la edición tiene que viajar con el premio nuevo",
  );

  const listado = await pedir("GET", "/game-modes");
  assert.equal(listado.status, 200, "el GET del catálogo es PÚBLICO y no pide llave");
  assert.ok(
    (listado.body.data as readonly { uuid: string }[]).some((modo) => modo.uuid === uuid),
    "normal tiene que dejar el modo ACTIVO para las fases siguientes",
  );

  logger.info("smoke game-mode: fase normal ok", { uuid });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FASE `enqueue` — con el broker CAÍDO
// ─────────────────────────────────────────────────────────────────────────────────────────────

// NO ABRE AMQP, y no es una omisión: abrir una conexión contra el broker apagado colgaría esta
// fase para siempre (`recovery: true` reintenta infinito, §`src/shared/amqp.ts`). Lo que se mide
// acá es que el REQUEST ADMINISTRATIVO NO DEPENDE DEL BROKER — la mutación contesta 200 con Rabbit
// muerto— y que el evento quedó guardado en vez de perderse.
async function enqueue(): Promise<void> {
  const modo = await esperarHasta("el modo que dejó la fase normal", async () => {
    const listado = await pedir("GET", "/game-modes");
    return (listado.body.data as readonly { uuid: string; name: string }[]).find(
      (candidato) => candidato.name === MODO.name,
    );
  });

  const editado = await pedir("PUT", `/game-modes/${modo.uuid}`, {
    body: { prize: 99 },
    key: KEY,
  });
  assert.equal(
    editado.status,
    200,
    "con Rabbit caído la mutación TIENE que contestar OK: el panel no espera al broker",
  );
  assert.equal((editado.body.data as Record<string, unknown>).prize, 99);
  const revisión = (editado.body.data as Record<string, unknown>).__v as number;

  // EL EVENTO EXACTO, TODAVÍA PENDING. Se busca por su `dedupeKey` —`uuid` + revisión— y no por
  // "el último": con "el último" el test pasaría aunque el evento fuera el de otra mutación.
  await conMongo(async (db) => {
    const clave = JSON.stringify(["game_mode.updated", modo.uuid, revisión]);
    const entrada = await esperarHasta(`el evento ${clave} en game_mode_outbox`, () =>
      db.collection("game_mode_outbox").findOne({ dedupeKey: clave }),
    );
    assert.equal(entrada.status, "PENDING", "con el broker caído el evento NO puede estar SENT");
    assert.equal((entrada.payload as Record<string, unknown>).prize, 99);
  });

  logger.info("smoke game-mode: fase enqueue ok", { uuid: modo.uuid, revisión });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FASE `recover` — con el broker de vuelta
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function recover(): Promise<void> {
  const modo = await esperarHasta("el modo del smoke", async () => {
    const listado = await pedir("GET", "/game-modes");
    return (listado.body.data as readonly { uuid: string; name: string }[]).find(
      (candidato) => candidato.name === MODO.name,
    );
  });

  // LO PENDIENTE SALE SOLO. Nadie vuelve a tocar HTTP acá: el despachador tiene que haberlo
  // publicado por su cuenta al volver el broker, que es la promesa entera del outbox.
  const recuperados = await drenarCola(1);
  assert.ok(
    recuperados.some((evento) => evento.prize === 99),
    `el evento encolado con el broker caído nunca salió — llegaron: ${JSON.stringify(recuperados)}`,
  );

  await conMongo(async (db) => {
    await esperarHasta("el evento de la fase enqueue marcado SENT", async () => {
      const entrada = await db
        .collection("game_mode_outbox")
        .findOne({ "payload.prize": 99, status: "SENT" });
      return entrada ?? undefined;
    });

    // LA VENTANA MODO→OUTBOX, ROTA A MANO. Se avanza el `__v` del documento SIN escribir el outbox,
    // que es exactamente lo que queda si el proceso muere entre las dos escrituras —no hay replica
    // set, así que no hay transacción que las una—. El reconciliador es lo único que cubre eso, y
    // es la pieza que ningún test de la suite puede ejercitar de punta a punta.
    const roto = await db
      .collection("game_modes_domino")
      .findOneAndUpdate(
        { uuid: modo.uuid },
        { $inc: { __v: 1 }, $set: { prize: 123, updatedAt: new Date() } },
        { returnDocument: "after" },
      );
    assert.ok(roto, "no se pudo romper la ventana a mano");
    const revisiónHuérfana = roto.__v as number;
    const clave = JSON.stringify(["game_mode.updated", modo.uuid, revisiónHuérfana]);

    await esperarHasta(`el reconciliador emitiendo ${clave}`, () =>
      db.collection("game_mode_outbox").findOne({ dedupeKey: clave }),
    );
    logger.info("smoke game-mode: el reconciliador cerró la ventana", { clave });
  });

  const reconciliados = await drenarCola(1);
  assert.ok(
    reconciliados.some((evento) => evento.prize === 123),
    `el reconciliador no publicó la revisión huérfana — llegaron: ${JSON.stringify(reconciliados)}`,
  );

  // LAS DOS INSTANCIAS PM2 SIRVEN EL MISMO CATÁLOGO. Vive en Mongo, así que las dos tienen que
  // contestar lo mismo: si alguien lo volviera a poner en memoria, cada proceso contestaría lo suyo
  // y nadie se enteraría hasta producción.
  for (const puerto of [2567, 2568]) {
    const listado = await esperarHasta(`el catálogo por el puerto ${puerto}`, async () => {
      const response = await pedir("GET", `/${puerto}/game-modes`);
      return response.status === 200 ? response : undefined;
    });
    const modos = listado.body.data as readonly { uuid: string; prize: number }[];
    const encontrado = modos.find((candidato) => candidato.uuid === modo.uuid);
    assert.ok(encontrado, `la instancia ${puerto} no ve el modo del catálogo compartido`);
    assert.equal(
      encontrado.prize,
      123,
      `la instancia ${puerto} contesta una revisión vieja: el catálogo no es compartido`,
    );
  }

  logger.info("smoke game-mode: fase recover ok", { uuid: modo.uuid });
}

const FASES = { normal, enqueue, recover } as const;

async function run(): Promise<void> {
  assert.equal(env.runEngineSmoke, true, "game-mode-smoke exige RUN_ENGINE_SMOKE=1");
  assert.ok(KEY, "el cliente smoke necesita INTERNAL_API_KEY para las mutaciones");
  const fase = process.argv[2] as keyof typeof FASES | undefined;
  assert.ok(fase && fase in FASES, `fase desconocida: ${fase} — usá normal | enqueue | recover`);
  await FASES[fase]();
}

run()
  .catch((error) => {
    logger.error("smoke game-mode: falló", { error: String(error) });
    process.exitCode = 1;
  })
  // SE SALE EXPLÍCITAMENTE, por lo mismo que `engine-smoke.ts`: una conexión de Mongo o de AMQP
  // que quedó abierta por un camino de error sostiene el event loop, y una fase colgada es un
  // runner colgado — en verde y sin decir nada. Ver el comentario largo en el otro archivo.
  .finally(() => process.exit(process.exitCode ?? 0));
