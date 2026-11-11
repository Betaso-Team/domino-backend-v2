import type { Collection, Document, IndexDescription, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import type { CollectionSource } from "./mongo-lease";
import type {
  EnqueueOptions,
  OutboxClock,
  OutboxEntry,
  OutboxRecord,
  OutboxStatus,
  OutboxStore,
} from "./outbox";

// EL ALMACÉN DURABLE DE UN OUTBOX, parametrizado por colección. Hoy lo usan los resultados de partida
// (`match_result_outbox`); cada uso es dueño de su colección y de sus claves. La vieja
// `game_mode_outbox` del catálogo quedó huérfana en las bases que la tenían: nadie la lee.
//
// SIN MONGOOSE: el driver oficial y el documento a la vista.

// EL CÓDIGO DE CLAVE DUPLICADA de Mongo, comparado por NÚMERO y nunca por texto (ver
// `mongo-lease.ts`): el mensaje cambia entre versiones del servidor y está pensado para un humano.
const DUPLICATE_KEY = 11000;

// LOS ÍNDICES.
//
// `dedupeKey` único es LA idempotencia: no es una consulta previa, es la base rechazando el segundo
// insert. `exclusiveKey` único PARCIAL (solo los documentos que lo tienen) es la exclusión por
// desenlace: una partida tiene `finished` o `aborted`, y el segundo insert lo rechaza la base, no una
// consulta previa que otro proceso puede adelantar. `{status, _id}` cubre `hasPending()` (una vez por
// segundo, para siempre); `{status, attempts, _id}` es el orden de `next()`; `{status, sentAt}` es la
// compactación.
//
// SIN TTL. Antes lo enviado se BORRABA a los siete días (`sentAt_1`, TTL), y con eso
// `GET /internal/matches/:matchId/existence` contestaba `outcome: "none"` por una partida publicada: el
// orquestador la abortaría. Ahora lo enviado se COMPACTA (`compactSent`): pierde el cuerpo y queda la
// lápida (`dedupeKey`, `exclusiveKey`, `status`, `sentAt`), unas decenas de bytes por partida. El
// índice TTL viejo se borra al preparar la colección.
const OUTBOX_INDEXES: IndexDescription[] = [
  { key: { dedupeKey: 1 }, name: "dedupeKey_1", unique: true },
  {
    key: { exclusiveKey: 1 },
    name: "exclusiveKey_1",
    unique: true,
    partialFilterExpression: { exclusiveKey: { $exists: true } },
  },
  { key: { status: 1, _id: 1 }, name: "status_1__id_1" },
  { key: { status: 1, attempts: 1, _id: 1 }, name: "status_1_attempts_1__id_1" },
  { key: { status: 1, sentAt: 1 }, name: "status_1_sentAt_1" },
];
// El TTL que borraba lo enviado: se quita si está.
const LEGACY_TTL_INDEX = "sentAt_1";

// LA FORMA DEL DOCUMENTO. El `_id` es `ObjectId` y es el ORDEN: monótono dentro de un proceso y
// comparable entre procesos. Opcional porque el insert NO lo manda: lo asigna la base.
export interface OutboxDocument<K extends string = string, P = unknown> extends OutboxRecord<K, P> {
  _id?: ObjectId;
  // LEGADO: el plazo de reintento por entrada, que causaba bloqueo de cabeza. Lo traen los documentos
  // escritos antes; nadie lo escribe ni lo lee.
  nextAttemptAt?: Date;
}

export class MongoOutboxStore<K extends string = string, P = unknown> implements OutboxStore<K, P> {
  // La colección YA PREPARADA, memoizada: los índices son trabajo de arranque.
  private prepared?: Promise<Collection<OutboxDocument<K, P>>>;

  constructor(
    private readonly source: CollectionSource,
    private readonly collectionName: string,
    private readonly clock: OutboxClock,
  ) {}

  async enqueue(
    dedupeKey: string,
    routingKey: K,
    payload: P,
    options: EnqueueOptions = {},
  ): Promise<boolean> {
    const now = new Date(this.clock.now());
    const document: OutboxRecord<K, P> = {
      dedupeKey,
      routingKey,
      payload,
      status: "PENDING",
      attempts: 0,
      strikes: 0,
      ...(options.exclusiveKey === undefined ? {} : { exclusiveKey: options.exclusiveKey }),
      createdAt: now,
    };
    try {
      await (await this.collection()).insertOne(document as OutboxDocument<K, P>);
      return true;
    } catch (error) {
      // EL DUPLICADO ES EL CAMINO ORDINARIO DE "YA ESTABA". Cualquier OTRO fallo sube: tragárselo
      // convertiría un Mongo caído en un outbox que acepta y no guarda.
      if (!isDuplicateKey(error)) throw error;
      return false;
    }
  }

  async present(keys: readonly string[]): Promise<ReadonlySet<string>> {
    // Sin claves no hay nada que preguntar: un `$in: []` por segundo es un round-trip para nada.
    if (keys.length === 0) return new Set();
    const found = await (await this.collection())
      .find({ dedupeKey: { $in: [...keys] } }, { projection: { dedupeKey: 1 } })
      .toArray();
    return new Set(found.map((document) => document.dedupeKey));
  }

  async statuses(keys: readonly string[]): Promise<ReadonlyMap<string, OutboxStatus>> {
    if (keys.length === 0) return new Map();
    const found = await (await this.collection())
      .find({ dedupeKey: { $in: [...keys] } }, { projection: { dedupeKey: 1, status: 1 } })
      .toArray();
    return new Map(found.map((document) => [document.dedupeKey, document.status] as const));
  }

  async parkedCount(): Promise<number> {
    return (await this.collection()).countDocuments({ status: "PARKED" });
  }

  // LO ENVIADO HACE MÁS DE `olderThanMs` PIERDE EL CUERPO y queda la lápida. Idempotente: lo ya
  // compactado no tiene `payload` y no vuelve a entrar. @returns cuántas compactó.
  async compactSent(olderThanMs: number): Promise<number> {
    const cutoff = new Date(this.clock.now() - olderThanMs);
    const result = await (await this.collection()).updateMany(
      { status: "SENT", sentAt: { $lt: cutoff }, payload: { $exists: true } },
      // El tipo del driver no deja `$unset` sobre un campo genérico (`P`): se arma sin tipar.
      { $unset: { payload: "" }, $set: { compacted: true } } as Document,
    );
    return result.modifiedCount;
  }

  async hasPending(): Promise<boolean> {
    // CUBIERTA por `status_1__id_1`: filtra por `status`, ordena por `_id` y proyecta sólo `_id`.
    const found = await (await this.collection()).findOne(
      { status: "PENDING" },
      { sort: { _id: 1 }, projection: { _id: 1 } },
    );
    return found !== null;
  }

  async next(): Promise<OutboxEntry<K, P> | undefined> {
    // EL DE MENOS INTENTOS y, entre iguales, el más viejo (`status_1_attempts_1__id_1`), sin mirar
    // `nextAttemptAt` (legado): una entrada que falló queda detrás de las que no se intentaron.
    const oldest = await (await this.collection()).findOne(
      { status: "PENDING" },
      { sort: { attempts: 1, _id: 1 } },
    );
    return oldest ? entryOf(oldest as WithId<OutboxDocument<K, P>>) : undefined;
  }

  async sent(id: string, at: Date): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "SENT", sentAt: at } },
    );
  }

  async retry(id: string, error: string, strike = false): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { lastError: error },
        // LOS INTENTOS SON UN `$inc` DE LA BASE y no `leído + 1`: entre leer y escribir puede haber
        // otro proceso cuyo lease venció, y la cuenta perdería un intento.
        $inc: strike ? { attempts: 1, strikes: 1 } : { attempts: 1 },
      },
    );
  }

  // SÓLO UNA PENDIENTE: una que otro proceso ya marcó `SENT` no se estaciona.
  async park(id: string, error: string, at: Date): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id), status: "PENDING" },
      { $set: { status: "PARKED", parkedAt: at, lastError: error } },
    );
  }

  private collection(): Promise<Collection<OutboxDocument<K, P>>> {
    this.prepared ??= this.prepare().catch((error: unknown) => {
      // Se limpia al fallar: un Mongo que todavía no había levantado no deja al outbox pegado a una
      // promesa rechazada hasta reiniciar.
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  private async prepare(): Promise<Collection<OutboxDocument<K, P>>> {
    const collection = await this.source.collection<OutboxDocument<K, P>>(this.collectionName);
    // EL TTL VIEJO SE BORRA ANTES de crear los índices: mientras exista, Mongo sigue borrando lo
    // enviado. Que no esté (colección nueva, o ya borrado) es el caso normal.
    await collection.dropIndex(LEGACY_TTL_INDEX).catch((error: unknown) => {
      if (!isMissingIndex(error)) throw error;
    });
    await collection.createIndexes(OUTBOX_INDEXES);
    return collection;
  }
}

// EL MAPPER: `_id` → `id` (hex, porque el puerto promete un id opaco).
function entryOf<K extends string, P>(document: WithId<OutboxDocument<K, P>>): OutboxEntry<K, P> {
  return {
    id: document._id.toHexString(),
    dedupeKey: document.dedupeKey,
    routingKey: document.routingKey,
    payload: document.payload,
    status: document.status,
    attempts: document.attempts,
    strikes: document.strikes ?? 0,
    ...(document.exclusiveKey === undefined ? {} : { exclusiveKey: document.exclusiveKey }),
    createdAt: document.createdAt,
    sentAt: document.sentAt,
    lastError: document.lastError,
  };
}

// `IndexNotFound` (27) y `NamespaceNotFound` (26): no había nada que borrar.
function isMissingIndex(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 27 || code === 26;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
