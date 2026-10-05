import { MongoOutboxStore, type OutboxDocument } from "@/shared/mongo-outbox";
import type { GameMode } from "../core/game-mode";
import {
  type GameModeEvent,
  type GameModeEventKey,
  type GameModePayload,
  createdEventOf,
  updatedEventOf,
} from "../events";
import {
  type Clock,
  type GameModeOutbox,
  type GameModeOutboxEntry,
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

// LA FORMA DEL DOCUMENTO, la del almacén compartido (`shared/mongo-outbox.ts`): dos índices
// (`dedupeKey` único, `{status, _id}`) y NINGÚN TTL. Los `SENT` son lo que hace que la reconciliación
// no vuelva a emitir toda revisión ya publicada en cada tick.
export type GameModeOutboxDocument = OutboxDocument<GameModeEventKey, GameModePayload>;

export class MongoGameModeOutbox implements GameModeOutbox {
  private readonly store: MongoOutboxStore<GameModeEventKey, GameModePayload>;

  constructor(source: CollectionSource, clock: Clock) {
    this.store = new MongoOutboxStore(source, GAME_MODE_OUTBOX_COLLECTION, clock);
  }

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
    const present = await this.store.present(modes.flatMap((mode) => revisionKeysOf(mode)));
    for (const mode of modes) {
      if (revisionKeysOf(mode).some((key) => present.has(key))) continue;
      // EL EVENTO PERDIDO VUELVE COMO `updated`, incluso si el que se perdió era el `created`:
      // exactamente la estrategia de recuperación del `/sync` de v1. El cuerpo es el mismo y el
      // consumidor upsertea por `id`, así que la clave de ruteo es lo único que cambia — y mirando el
      // modo no hay forma de saber cuál de los dos faltó.
      await this.ensureUpdated(mode);
    }
  }

  next(now: Date): Promise<GameModeOutboxEntry | undefined> {
    return this.store.next(now);
  }

  sent(id: string, at: Date): Promise<void> {
    return this.store.sent(id, at);
  }

  retry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    return this.store.retry(id, error, nextAttemptAt);
  }

  // EL DUPLICADO ES EL CAMINO ORDINARIO DE "YA ESTABA": lo produce el reintento del servicio y la
  // carrera entre el escritor del catálogo y el reconciliador. Cualquier otro fallo sube.
  private async insert(dedupeKey: string, event: GameModeEvent): Promise<void> {
    await this.store.enqueue(dedupeKey, event.key, event.payload);
  }
}
