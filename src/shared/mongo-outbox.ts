import type { Collection, IndexDescription, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import type { CollectionSource } from "./mongo-lease";
import type { OutboxClock, OutboxEntry, OutboxRecord, OutboxStore } from "./outbox";

// EL ALMACÉN DURABLE DE UN OUTBOX, parametrizado por colección. Lo usan el catálogo
// (`game_mode_outbox`) y los resultados de partida (`match_result_outbox`); cada uno es dueño de su
// colección y de sus claves, y ninguno lee la del otro.
//
// SIN MONGOOSE: el driver oficial y el documento a la vista.

// EL CÓDIGO DE CLAVE DUPLICADA de Mongo, comparado por NÚMERO y nunca por texto (ver
// `mongo-lease.ts`): el mensaje cambia entre versiones del servidor y está pensado para un humano.
const DUPLICATE_KEY = 11000;

// LOS DOS ÍNDICES, Y NINGÚN TTL.
//
// `dedupeKey` único es LA idempotencia: no es una consulta previa, es la base rechazando el segundo
// insert. `{status, _id}` es la consulta de `next()`, que corre una vez por segundo para siempre.
//
// **NO HAY TTL NI BORRADO**: los `SENT` son lo que hace que una clave ya entregada no se vuelva a
// encolar (la reconciliación del catálogo, el resultado de una partida que se cierra dos veces).
const OUTBOX_INDEXES: IndexDescription[] = [
  { key: { dedupeKey: 1 }, name: "dedupeKey_1", unique: true },
  { key: { status: 1, _id: 1 }, name: "status_1__id_1" },
];

// LA FORMA DEL DOCUMENTO. El `_id` es `ObjectId` y es el ORDEN: monótono dentro de un proceso y
// comparable entre procesos. Opcional porque el insert NO lo manda: lo asigna la base.
export interface OutboxDocument<K extends string = string, P = unknown> extends OutboxRecord<K, P> {
  _id?: ObjectId;
}

export class MongoOutboxStore<K extends string = string, P = unknown> implements OutboxStore<K, P> {
  // La colección YA PREPARADA, memoizada: los índices son trabajo de arranque.
  private prepared?: Promise<Collection<OutboxDocument<K, P>>>;

  constructor(
    private readonly source: CollectionSource,
    private readonly collectionName: string,
    private readonly clock: OutboxClock,
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
      // NACE VENCIDA: el primer intento es AHORA.
      nextAttemptAt: now,
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

  async next(now: Date): Promise<OutboxEntry<K, P> | undefined> {
    // EL PENDIENTE MÁS VIEJO, y sin filtrar por `nextAttemptAt` en la consulta: con el filtro adentro
    // saldría el SIGUIENTE cuando el primero todavía espera su reintento. El plazo se compara DESPUÉS.
    const oldest = await (await this.collection()).findOne(
      { status: "PENDING" },
      { sort: { _id: 1 } },
    );
    if (!oldest || oldest.nextAttemptAt.getTime() > now.getTime()) return undefined;
    return entryOf(oldest as WithId<OutboxDocument<K, P>>);
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
        // LOS INTENTOS SON UN `$inc` DE LA BASE y no `leído + 1`: entre leer y escribir puede haber
        // otro proceso cuyo lease venció, y el backoff se quedaría clavado en el primer escalón.
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
    createdAt: document.createdAt,
    nextAttemptAt: document.nextAttemptAt,
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
