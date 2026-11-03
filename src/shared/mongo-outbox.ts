import type { Collection, IndexDescription, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import type { CollectionSource } from "./mongo-lease";
import type { OutboxClock, OutboxEntry, OutboxRecord, OutboxStore } from "./outbox";

// EL ALMACÉN DURABLE DE UN OUTBOX, parametrizado por colección. Hoy lo usan los resultados de partida
// (`match_result_outbox`); cada uso es dueño de su colección y de sus claves. La vieja
// `game_mode_outbox` del catálogo quedó huérfana en las bases que la tenían: nadie la lee.
//
// SIN MONGOOSE: el driver oficial y el documento a la vista.

// EL CÓDIGO DE CLAVE DUPLICADA de Mongo, comparado por NÚMERO y nunca por texto (ver
// `mongo-lease.ts`): el mensaje cambia entre versiones del servidor y está pensado para un humano.
const DUPLICATE_KEY = 11000;

// LOS DOS ÍNDICES, y el TTL solo si el uso lo pide.
//
// `dedupeKey` único es LA idempotencia: no es una consulta previa, es la base rechazando el segundo
// insert. `{status, _id}` es la consulta de `next()` y la de `hasPending()`, que corre una vez por
// segundo para siempre y el índice CUBRE: no lee ningún documento.
//
// EL TTL ES OPCIONAL porque un outbox con reconciliación necesitaría sus `SENT` para siempre. Los
// RESULTADOS vencen (`sentRetentionSeconds`): nadie los reconcilia, y una partida no se cierra dos veces con días de diferencia. El TTL va sobre `sentAt`, que una entrada
// pendiente no tiene, y Mongo no vence un documento sin el campo: **lo que no salió no vence nunca**.
// Mientras dura, un resultado enviado sigue acá entero, y volverlo a `PENDING` lo publica otra vez:
// es la red si el broker pierde su disco antes de que el orquestador lo consuma.
const OUTBOX_INDEXES: IndexDescription[] = [
  { key: { dedupeKey: 1 }, name: "dedupeKey_1", unique: true },
  { key: { status: 1, _id: 1 }, name: "status_1__id_1" },
];

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
    private readonly options: { readonly sentRetentionSeconds?: number } = {},
  ) {}

  async enqueue(dedupeKey: string, routingKey: K, payload: P): Promise<boolean> {
    const now = new Date(this.clock.now());
    const document: OutboxRecord<K, P> = {
      dedupeKey,
      routingKey,
      payload,
      status: "PENDING",
      attempts: 0,
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

  async hasPending(): Promise<boolean> {
    // CUBIERTA por `status_1__id_1`: filtra por `status`, ordena por `_id` y proyecta sólo `_id`.
    const found = await (await this.collection()).findOne(
      { status: "PENDING" },
      { sort: { _id: 1 }, projection: { _id: 1 } },
    );
    return found !== null;
  }

  async next(): Promise<OutboxEntry<K, P> | undefined> {
    // EL PENDIENTE MÁS VIEJO, sin mirar `nextAttemptAt` (legado): la espera tras un fallo es del
    // despachador, y un plazo por entrada bloqueaba a toda la cola detrás de la primera.
    const oldest = await (await this.collection()).findOne(
      { status: "PENDING" },
      { sort: { _id: 1 } },
    );
    return oldest ? entryOf(oldest as WithId<OutboxDocument<K, P>>) : undefined;
  }

  async sent(id: string, at: Date): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: "SENT", sentAt: at } },
    );
  }

  async retry(id: string, error: string): Promise<void> {
    await (await this.collection()).updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { lastError: error },
        // LOS INTENTOS SON UN `$inc` DE LA BASE y no `leído + 1`: entre leer y escribir puede haber
        // otro proceso cuyo lease venció, y la cuenta perdería un intento.
        $inc: { attempts: 1 },
      },
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
    const retention = this.options.sentRetentionSeconds;
    await collection.createIndexes(
      retention === undefined
        ? OUTBOX_INDEXES
        : [
            ...OUTBOX_INDEXES,
            { key: { sentAt: 1 }, name: "sentAt_1", expireAfterSeconds: retention },
          ],
    );
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
    createdAt: document.createdAt,
    sentAt: document.sentAt,
    lastError: document.lastError,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
