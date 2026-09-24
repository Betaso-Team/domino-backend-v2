import type { Collection, IndexDescription, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import type { GameMode } from "../core/game-mode";
import { type GameModeEvent, createdEventOf, updatedEventOf } from "../events";
import {
  type Clock,
  type GameModeOutbox,
  type GameModeOutboxEntry,
  type GameModeOutboxRecord,
  createdKeyOf,
  revisionKeysOf,
  syncKeyOf,
  updatedKeyOf,
} from "../outbox";
import type { CollectionSource } from "./mongo-repository";

// EL OUTBOX DURABLE. Es la mitad del incremento que hace que el request administrativo no espere a
// Rabbit: la mutación escribe el modo y escribe acá, las dos en Mongo, y el dispatcher publica
// después. Sin esta colección, un broker caído sería un cambio del catálogo que se aplica en la base y
// no llega nunca al consumidor, sin rastro de que faltó.
//
// SIN MONGOOSE, igual que el repositorio: el driver oficial y el documento a la vista.

// LA COLECCIÓN, en una constante y no en una variable de entorno, por el mismo argumento que
// `GAME_MODE_COLLECTION` y `LEASE_COLLECTION`: el dominó es su único escritor y un nombre configurable
// sería un valor que nadie cambia y que se puede escribir mal — y escribirlo mal acá es un outbox
// vacío mientras el otro se llena de pendientes que nadie publica.
export const GAME_MODE_OUTBOX_COLLECTION = "game_mode_outbox";

// EL CÓDIGO DE CLAVE DUPLICADA de Mongo, comparado por NÚMERO y nunca por texto. Está repetido de
// `shared/mongo-lease.ts` y no importado: `shared/` no puede depender de `features/` ni al revés por
// una constante, y el mensaje real (`E11000 duplicate key error collection: …`) cambia entre versiones
// del servidor y está pensado para un humano. Ver el argumento completo allá.
const DUPLICATE_KEY = 11000;

// LOS DOS ÍNDICES, Y NINGÚN TTL.
//
// `dedupeKey` único es LA idempotencia: no es una consulta previa, es la base rechazando el segundo
// insert. Entre un `findOne` que no encuentra nada y el `insertOne` que sigue hay un turno del event
// loop, y dos procesos que lo aprovechen insertan los dos.
//
// `{status, _id}` es la consulta de `next()`, que corre una vez por segundo para siempre: sin él, cada
// tick recorre la colección entera, que no deja de crecer porque los `SENT` se conservan.
//
// **NO HAY TTL NI BORRADO**, y no es una omisión: los `SENT` son lo que hace que la reconciliación no
// vuelva a emitir toda revisión ya publicada en cada tick. Borrarlos a los N días convertiría al
// reconciliador en un republicador periódico del catálogo entero.
const OUTBOX_INDEXES: IndexDescription[] = [
  { key: { dedupeKey: 1 }, name: "dedupeKey_1", unique: true },
  { key: { status: 1, _id: 1 }, name: "status_1__id_1" },
];

// LA FORMA DEL DOCUMENTO, declarada SÓLO ACÁ. El `_id` es `ObjectId` y es el ORDEN: monótono dentro de
// un proceso y comparable entre procesos por su timestamp. Ordenar por `createdAt` colapsaría dos
// encolados del mismo milisegundo, que es exactamente el caso que el reloj inyectado del repositorio
// existe para poder medir.
//
// `_id` es opcional porque el insert NO lo manda: lo asigna la base y vuelve en `insertedId`.
export interface GameModeOutboxDocument extends GameModeOutboxRecord {
  _id?: ObjectId;
}

export class MongoGameModeOutbox implements GameModeOutbox {
  // La colección YA PREPARADA, memoizada, igual que en el repositorio: los índices son trabajo de
  // arranque y el dispatcher consulta una vez por segundo.
  private prepared?: Promise<Collection<GameModeOutboxDocument>>;

  constructor(
    private readonly source: CollectionSource,
    private readonly clock: Clock,
  ) {}

  async enqueueCreated(mode: GameMode): Promise<void> {
    await this.insert(createdKeyOf(mode), createdEventOf(mode));
  }

  async ensureUpdated(mode: GameMode): Promise<void> {
    await this.insert(updatedKeyOf(mode), updatedEventOf(mode));
  }

  async sync(modes: readonly GameMode[], batchId: string): Promise<number> {
    for (const mode of modes) {
      await this.insert(syncKeyOf(batchId, mode), updatedEventOf(mode));
    }
    // LO QUE SE ENCOLÓ, que es lo que el `POST /sync` de v1 contesta como `synced`.
    return modes.length;
  }

  // LA RECONCILIACIÓN, Y ES UNA SOLA CONSULTA. Pregunta por las claves CANDIDATAS de los modos que
  // recibió —dos por modo, resueltas contra el índice único— en vez de leer la colección, que no deja
  // de crecer.
  //
  // ponytail: el techo de esta forma es el TAMAÑO DEL CATÁLOGO, no el del outbox. Cada tick manda un
  // `$in` de `2 × modos` claves, una vez por segundo. Con las decenas de modos del catálogo productivo
  // de v1 es ruido; deja de ser adecuado del orden del millar, y ahí lo que hay que cambiar NO es esta
  // consulta sino la cadencia —reconciliar cada N ticks— o acotar los modos por una marca de agua
  // (`updatedAt` posterior a la última reconciliación). Las dos son cambios del llamador, no de acá.
  async reconcile(modes: readonly GameMode[]): Promise<void> {
    // Sin modos no hay nada que preguntar: un `$in: []` por segundo es un round-trip por segundo para
    // que la base conteste vacío.
    if (modes.length === 0) return;
    const candidates = modes.flatMap((mode) => revisionKeysOf(mode));
    const found = await (await this.collection())
      .find({ dedupeKey: { $in: candidates } }, { projection: { dedupeKey: 1 } })
      .toArray();
    const present = new Set(found.map((document) => document.dedupeKey));
    for (const mode of modes) {
      if (revisionKeysOf(mode).some((key) => present.has(key))) continue;
      // EL EVENTO PERDIDO VUELVE COMO `updated`, incluso si el que se perdió era el `created`:
      // exactamente la estrategia de recuperación del `/sync` de v1. El cuerpo es el mismo y el
      // consumidor upsertea por `id`, así que la clave de ruteo es lo único que cambia — y mirando el
      // modo no hay forma de saber cuál de los dos faltó.
      await this.ensureUpdated(mode);
    }
  }

  async next(now: Date): Promise<GameModeOutboxEntry | undefined> {
    // EL PENDIENTE MÁS VIEJO, y sin filtrar por `nextAttemptAt` en la consulta. Es la diferencia
    // entera: `{ status, nextAttemptAt: { $lte: now } }` devolvería el SIGUIENTE cuando el primero
    // todavía espera su reintento, y eso publica un `updated` antes que el `updated` anterior. El
    // plazo se compara DESPUÉS, sobre el que salió primero.
    const oldest = await (await this.collection()).findOne(
      { status: "PENDING" },
      { sort: { _id: 1 } },
    );
    if (!oldest || oldest.nextAttemptAt.getTime() > now.getTime()) return undefined;
    return entryOf(oldest);
  }

  async sent(id: string, at: Date): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "SENT", sentAt: at } },
    );
  }

  async retry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { nextAttemptAt, lastError: error },
        // LOS INTENTOS SON UN `$inc` DE LA BASE y no un número calculado en el proceso, por lo mismo
        // que el `__v` del repositorio: entre leer la entrada y escribirla puede haber otro proceso
        // cuyo lease venció, y con `leído + 1` los dos escriben el mismo número — el backoff se queda
        // clavado en el primer escalón y un broker caído recibe un intento por segundo.
        $inc: { attempts: 1 },
      },
    );
    // NO se toca `status`: nunca dejó de ser `PENDING`. Escribirlo igual sugeriría que existe un
    // estado "en vuelo" que este outbox no tiene, y no lo tiene a propósito: lo que protege a una
    // entrada tomada por un proceso que muere es el lease, no una marca en el documento.
  }

  private async insert(dedupeKey: string, event: GameModeEvent): Promise<void> {
    const now = new Date(this.clock.now());
    const document: GameModeOutboxRecord = {
      dedupeKey,
      routingKey: event.key,
      payload: event.payload,
      status: "PENDING",
      attempts: 0,
      createdAt: now,
      // NACE VENCIDA: el primer intento es AHORA. Nacer con el plazo del primer backoff le agregaría
      // un segundo de latencia a cada cambio del panel.
      nextAttemptAt: now,
    };
    try {
      await (await this.collection()).insertOne(document);
    } catch (error) {
      // EL DUPLICADO ES EL CAMINO ORDINARIO DE "YA ESTABA", no una rareza: lo produce el reintento del
      // servicio y lo produce la carrera entre el escritor del catálogo y el reconciliador. El estado
      // final es el que se quería, así que no hay nada que informar.
      //
      // Cualquier OTRO fallo sube: tragárselo convertiría un Mongo caído en un outbox que acepta
      // eventos y no guarda ninguno, o sea el catálogo desincronizado en silencio.
      if (!isDuplicateKey(error)) throw error;
    }
  }

  private collection(): Promise<Collection<GameModeOutboxDocument>> {
    this.prepared ??= this.prepare().catch((error: unknown) => {
      // Se limpia al fallar, igual que en el repositorio: sin esto, un Mongo que todavía no había
      // levantado deja al outbox pegado a una promesa rechazada hasta que alguien reinicie el proceso
      // — y un outbox muerto es un catálogo que no se publica nunca.
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  private async prepare(): Promise<Collection<GameModeOutboxDocument>> {
    const collection = await this.source.collection<GameModeOutboxDocument>(
      GAME_MODE_OUTBOX_COLLECTION,
    );
    await collection.createIndexes(OUTBOX_INDEXES);
    return collection;
  }
}

// EL MAPPER, y la única frontera entre los dos vocabularios: `_id` → `id` (hex, porque el puerto
// promete un id opaco y el dispatcher se lo devuelve a `sent`/`retry`). El resto de los nombres es el
// mismo a propósito — no hay un vocabulario de v1 que conservar acá, esta colección es nueva.
function entryOf(document: WithId<GameModeOutboxDocument>): GameModeOutboxEntry {
  return {
    id: document._id.toHexString(),
    dedupeKey: document.dedupeKey,
    routingKey: document.routingKey,
    payload: document.payload,
    status: document.status,
    attempts: document.attempts,
    createdAt: document.createdAt,
    nextAttemptAt: document.nextAttemptAt,
    sentAt: document.sentAt,
    lastError: document.lastError,
  };
}

// Estructural y por CÓDIGO, no `instanceof` ni una expresión regular sobre el mensaje. Ver
// `DUPLICATE_KEY`.
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
