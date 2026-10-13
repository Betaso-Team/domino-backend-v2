import type { Logger } from "@/logger";
import type { AmqpDelivery } from "@/shared/amqp";
import type { Lease } from "@/shared/mongo-lease";
import {
  type OutboxClock,
  type OutboxEntry,
  type OutboxQueue,
  type OutboxRecord,
  TopicOutboxDispatcher,
} from "@/shared/outbox";
import type { GameModeReader } from "./core/catalog";
import type { GameMode } from "./core/game-mode";
import {
  GAME_MODE_CREATED_KEY,
  GAME_MODE_EXCHANGE,
  GAME_MODE_UPDATED_KEY,
  type GameModeEventKey,
  type GameModePayload,
} from "./events";

// EL OUTBOX: EL PUERTO Y EL DESPACHADOR. Existe para una sola propiedad — **el request administrativo
// nunca espera a Rabbit**. La mutación escribe Mongo y escribe acá; el dispatcher publica después,
// con confirmación del broker, y reintenta hasta que entre. Un panel que esperara la publicación
// devolvería 500 cada vez que el broker se reinicia, con el catálogo ya cambiado en la base.
//
// LA ENTREGA ES AL MENOS UNA VEZ, y está aceptado explícitamente: un proceso que muere DESPUÉS del
// confirm y ANTES de marcar `SENT` republica, y el consumidor deduplica por `id` (upsert, que es como
// v1 lo consume). Lo que NO está aceptado es ADELANTARSE: `next()` no entrega la segunda entrada
// mientras la primera espera su reintento, porque eso reordena la historia del catálogo y un
// consumidor que aplica un `updated` viejo encima de uno nuevo se queda con el modo obsoleto sin que
// nada falle.
//
// EL DOCUMENTO NO VIVE ACÁ. Este archivo tiene el registro portable y el despachador; la forma BSON,
// la colección y los índices son del adaptador (`transports/mongo-outbox.ts`).

// EL NOMBRE DEL LEASE. Es global: un solo dispatcher publica en todo el despliegue, porque dos
// publicando a la vez entregan la misma entrada dos veces y —peor— pueden entregarlas cruzadas.
export const OUTBOX_LEASE = "outbox-publisher";

// EL TICK, EL PLAZO DE PUBLICACIÓN Y EL BACKOFF son los del despachador compartido
// (`shared/outbox.ts`): un segundo, cinco segundos, y de uno a trescientos sin límite de intentos.

// EL DISCRIMINADOR DE LAS CLAVES DE `sync`, y NO es una clave de ruteo: el evento sale igual como
// `game_mode.updated`. Se escribe distinto justamente para que un lote de `sync` no pueda suprimir
// —ni ser suprimido por— el evento de una revisión. Ver `syncKeyOf`.
const SYNC_TAG = "game_mode.sync";

export type { OutboxStatus } from "@/shared/outbox";

// EL RELOJ INYECTADO, el del outbox compartido: es una interfaz de un método y el tipado estructural
// une las tres declaraciones sin que ninguna sepa de las otras.
export type Clock = OutboxClock;

// LA ENTRADA y LO QUE SE PERSISTE, las del outbox compartido con la clave y el cuerpo del catálogo.
export type GameModeOutboxEntry = OutboxEntry<GameModeEventKey, GameModePayload>;
export type GameModeOutboxRecord = OutboxRecord<GameModeEventKey, GameModePayload>;

export interface GameModeOutbox extends OutboxQueue<GameModeEventKey, GameModePayload> {
  enqueueCreated(mode: GameMode): Promise<void>;
  ensureUpdated(mode: GameMode): Promise<void>;
  // El botón de "republicar todo" del operador. Devuelve cuántos modos encoló, que es lo que el
  // `POST /sync` de v1 contesta como `synced`.
  sync(modes: readonly GameMode[], batchId: string): Promise<number>;
  reconcile(modes: readonly GameMode[]): Promise<void>;
}

// LAS TRES CLAVES DE DEDUPLICACIÓN, ESCRITAS ACÁ Y NO EN CADA ADAPTADOR. El formato ES el contrato:
// dos adaptadores que lo escribieran por su cuenta derivarían, y una clave distinta entre el proceso
// con Mongo y el que no lo tiene es el mismo evento publicado dos veces.
//
// Serializadas con `JSON.stringify` de un arreglo y NO concatenadas, igual que el índice del registro
// de partidas y las claves de idempotencia de `settlementOf`: concatenando, `["a","b:c"]` y
// `["a:b","c"]` dan la misma cadena, y una colisión acá es un evento que NO se publica porque otro ya
// usó la clave.

// LA CREACIÓN NO LLEVA REVISIÓN, y esa ausencia tiene una consecuencia que hay que leer junto con
// `revisionKeysOf`: un modo se crea UNA sola vez y nace en `__v = 0`, así que el `uuid` ya lo
// identifica. Lo que NO se sigue de ahí es que esta clave cubra al modo para siempre — ver abajo.
export function createdKeyOf(mode: GameMode): string {
  return JSON.stringify([GAME_MODE_CREATED_KEY, mode.uuid]);
}

// `uuid + version`, y la revisión es el `__v` que la BASE incrementa (`$inc`), no el reloj. Dos
// cambios reales que compartieran revisión son un evento publicado y otro DESCARTADO EN SILENCIO —por
// eso el repositorio no la deriva de `updatedAt` ni la calcula en el proceso—.
export function updatedKeyOf(mode: GameMode): string {
  return JSON.stringify([GAME_MODE_UPDATED_KEY, mode.uuid, mode.version]);
}

// `batchId + uuid` Y NO `uuid + version`, y es la diferencia entera entre `sync` y `ensureUpdated`:
// `sync` DEBE forzar un evento aunque esa revisión ya se haya publicado. Con la clave de revisión, el
// operador apretaría "republicar todo" y no pasaría nada — justo en el caso en que lo aprieta, que es
// cuando el consumidor se quedó sin el evento.
export function syncKeyOf(batchId: string, mode: GameMode): string {
  return JSON.stringify([SYNC_TAG, batchId, mode.uuid]);
}

// LAS CLAVES QUE HACEN QUE UN MODO **NO** NECESITE RECONCILIACIÓN. La pregunta exacta que contestan
// es "¿este modo tiene el evento de **la revisión que tiene ahora**?", y las dos mitades de esa
// pregunta son igual de importantes.
//
// EN REVISIÓN CERO SON DOS CLAVES: el `created` ES el evento de la revisión cero. Mirando sólo el
// `updated`, cada alta del panel recibiría además un `updated` espurio en el primer tick, para
// siempre.
//
// ⚠ **DE LA REVISIÓN UNO EN ADELANTE, EL `created` NO CUENTA, y ésta es la línea que ya estuvo mal
// una vez.** `createdKeyOf` NO lleva revisión —a propósito: hay una sola creación por modo—, así que
// la clave del `created` existe para SIEMPRE una vez que el modo pasó por `enqueueCreated`. Si se la
// aceptara sin condición, `revisionKeysOf(mode).some(presente)` daría verdadero en la v1, en la v5 y
// en la v50: **el reconciliador quedaría apagado exactamente para los modos que crea el panel**, que
// son todos. Y como NO HAY TTL —también a propósito, porque los `SENT` son lo que impide republicar
// toda revisión ya entregada en cada tick—, esa lectura equivocada no es un bache transitorio: es
// permanente. La ventana modo→outbox, que es lo único que cierra la falta de transacción entre las
// dos colecciones, se cerraría sola y en silencio.
//
// O sea que las tres decisiones se sostienen entre sí y no se pueden tocar de a una: clave de
// creación sin revisión + sin TTL ⇒ el `created` sólo puede contar en la revisión cero.
//
// NO se mira la clave de `sync`: un lote forzado no es direccionable por revisión, así que un `sync`
// posterior a una ventana perdida deja que el reconciliador emita igual su `updated`. El costo es un
// duplicado que el consumidor ya deduplica; la alternativa sería que `sync` mintiera sobre qué
// revisión entregó.
export function revisionKeysOf(mode: GameMode): readonly string[] {
  return mode.version === 0 ? [createdKeyOf(mode), updatedKeyOf(mode)] : [updatedKeyOf(mode)];
}

// EL DESPACHADOR DEL CATÁLOGO: el compartido, con la reconciliación como trabajo previo de cada tick y
// UNA entrada por tick.
export class OutboxDispatcher {
  private readonly inner: TopicOutboxDispatcher<GameModeEventKey, GameModePayload>;

  constructor(
    // El catálogo ENTERO —`all()`, no `active()`—: un modo dado de baja cuyo `updated` se perdió tiene
    // que poder recuperarse igual, o el consumidor sigue ofreciendo para siempre un modo retirado.
    reader: GameModeReader,
    outbox: GameModeOutbox,
    delivery: AmqpDelivery,
    lease: Lease,
    clock: Clock,
    log: Logger,
  ) {
    this.inner = new TopicOutboxDispatcher({
      exchange: GAME_MODE_EXCHANGE,
      leaseName: OUTBOX_LEASE,
      queue: outbox,
      delivery,
      lease,
      clock,
      log,
      label: "evento del catálogo",
      beforeEach: async () => outbox.reconcile(await reader.all()),
    });
  }

  start(): void {
    this.inner.start();
  }

  wake(): void {
    this.inner.wake();
  }

  drain(): Promise<void> {
    return this.inner.drain();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
