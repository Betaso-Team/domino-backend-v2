import type { Logger } from "@/logger";
import type { AmqpDelivery } from "@/shared/amqp";
import type { Lease } from "@/shared/mongo-lease";
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

// Quince segundos, igual que el lease del escritor del catálogo. No se renueva (ver
// `shared/mongo-lease.ts`), y la contramedida es que adentro no vaya un trabajo largo: UNA entrada
// por adquisición y nunca un bucle.
const LEASE_TTL_MS = 15_000;

// UN TICK POR SEGUNDO. Es el piso de latencia de un cambio que nadie despertó —una reconciliación, un
// reintento vencido—; el camino normal no lo espera porque la mutación llama `wake()`.
const TICK_MS = 1_000;

// EL PLAZO DE LA PUBLICACIÓN, Y NO ES DECORACIÓN. `AmqpPublisher.publishTopic` **no rechaza solo con
// el broker caído: se cuelga** —`connect()` con `recovery: true` reintenta para siempre y su promesa
// nunca se resuelve (ver la cabecera de `shared/amqp.ts`)—. Sin este plazo, el primer tick contra un
// Rabbit apagado se queda esperando con el lease tomado, el outbox deja de drenar y no aparece ni un
// error en el log: el catálogo se desincroniza en silencio, que es exactamente lo que este archivo
// existe para impedir.
const PUBLISH_TIMEOUT_MS = 5_000;

// EL BACKOFF: duplica desde un segundo y se corta en cinco minutos. El techo es lo que impide que
// doce fallos seguidos dejen el próximo intento a más de un día.
//
// **NO HAY LÍMITE DE INTENTOS, y la ausencia es la decisión.** Un evento que se descarta al intento
// número N es una pérdida silenciosa: el consumidor se queda con el catálogo viejo y del lado de acá
// todo está "resuelto". Una caída larga del broker tiene que costar retraso, no datos. Lo que crece
// es la tabla, y eso se ve.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

// EL DISCRIMINADOR DE LAS CLAVES DE `sync`, y NO es una clave de ruteo: el evento sale igual como
// `game_mode.updated`. Se escribe distinto justamente para que un lote de `sync` no pueda suprimir
// —ni ser suprimido por— el evento de una revisión. Ver `syncKeyOf`.
const SYNC_TAG = "game_mode.sync";

export type OutboxStatus = "PENDING" | "SENT";

// EL RELOJ INYECTADO, redeclarado acá por lo mismo que en `transports/mongo-repository.ts` y en
// `shared/mongo-lease.ts`: es una interfaz de un método y el tipado estructural une las tres sin que
// ninguna sepa de las otras. Sin él, medir el backoff exigiría esperar cinco minutos de verdad.
export interface Clock {
  now(): number;
}

// LA ENTRADA PORTABLE. `id` es opaco —el adaptador Mongo pone el hex de su `ObjectId`— y es lo único
// que el dispatcher le devuelve a `sent`/`retry`.
export interface GameModeOutboxEntry {
  readonly id: string;
  readonly dedupeKey: string;
  // LA CLAVE Y EL CUERPO VIAJAN JUNTOS, persistidos los dos: el publicador no decide ninguno de los
  // dos. Separarlos dejaría que una entrada se publique con la clave de otra, y en un topic exchange
  // eso es un mensaje que llega a la cola equivocada sin error de nadie.
  readonly routingKey: GameModeEventKey;
  readonly payload: GameModePayload;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly nextAttemptAt: Date;
  readonly sentAt?: Date;
  readonly lastError?: string;
}

// LO QUE SE PERSISTE, que es la entrada SIN su identidad: el `id` lo pone el almacén —el hex del
// `ObjectId` del lado de Mongo— y por eso no se puede escribir. Lo nombra el adaptador durable para
// declarar su documento sin repetir nueve campos que entonces podrían derivar del puerto.
export type GameModeOutboxRecord = Omit<GameModeOutboxEntry, "id">;

export interface GameModeOutbox {
  enqueueCreated(mode: GameMode): Promise<void>;
  ensureUpdated(mode: GameMode): Promise<void>;
  // El botón de "republicar todo" del operador. Devuelve cuántos modos encoló, que es lo que el
  // `POST /sync` de v1 contesta como `synced`.
  sync(modes: readonly GameMode[], batchId: string): Promise<number>;
  reconcile(modes: readonly GameMode[]): Promise<void>;
  // El pendiente más viejo, SI YA LE TOCA. Devuelve vacío —y no el siguiente— cuando el más viejo
  // todavía espera su reintento: ver la regla de no adelantarse, arriba.
  next(now: Date): Promise<GameModeOutboxEntry | undefined>;
  sent(id: string, at: Date): Promise<void>;
  retry(id: string, error: string, nextAttemptAt: Date): Promise<void>;
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

// EL DESPACHADOR. Un tick = un lease, una reconciliación y UNA entrada.
export class OutboxDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  // LA GUARDA DE CONCURRENCIA ES SUYA Y NO DEL LEASE, y hay que saber por qué: `MongoLease` excluye
  // PROCESOS y no llamadas —el dueño es por proceso, así que dos ticks de la misma instancia entran
  // los dos (ver el comentario del `owner` en `shared/mongo-lease.ts`)—. Sin esta promesa compartida,
  // un `wake()` que cae encima del tick programado publica la misma entrada dos veces.
  private inFlight?: Promise<boolean>;
  private closed = false;

  constructor(
    // El catálogo ENTERO —`all()`, no `active()`—: un modo dado de baja cuyo `updated` se perdió tiene
    // que poder recuperarse igual, o el consumidor sigue ofreciendo para siempre un modo retirado.
    private readonly reader: GameModeReader,
    private readonly outbox: GameModeOutbox,
    private readonly delivery: AmqpDelivery,
    private readonly lease: Lease,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.timer || this.closed) return;
    const timer = setInterval(() => {
      this.wake();
    }, TICK_MS);
    // DESREFERENCIADO: un intervalo referenciado mantiene vivo el event loop y el proceso no termina
    // de salir nunca. Es la misma decisión que el plazo de `shared/http/health.ts`.
    timer.unref?.();
    this.timer = timer;
  }

  // ADELANTA EL TICK tras una mutación, para que el panel no pague hasta un segundo de latencia. No
  // devuelve promesa a propósito: el request administrativo no espera a Rabbit. Si ya hay un tick
  // corriendo, éste se une a él y el cambio recién escrito lo toma el siguiente — a lo sumo un
  // segundo después.
  wake(): void {
    void this.tick().catch((error: unknown) => {
      // SE REGISTRA Y NO SE PROPAGA. Ni el temporizador ni el llamador de `wake()` tienen a quién
      // devolverle el error, y una promesa rechazada sin manejador tumba el proceso en Node — con
      // todas sus partidas en curso.
      this.log.error("el tick del outbox falló", { error: String(error) });
    });
  }

  // VACÍA LO QUE YA VENCIÓ, un tick por vuelta. El bucle está AFUERA del lease a propósito: adentro
  // iría un trabajo de duración desconocida contra un lease que no se renueva.
  async drain(): Promise<void> {
    let published = true;
    while (published) {
      published = await this.tick();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // SE ESPERA EL TICK EN VUELO. Sin esta línea, el apagado le cierra la conexión AMQP por debajo a
    // una entrega que estaba confirmando: el mensaje puede haber salido y la marca de entregado no
    // llega nunca, o sea un duplicado garantizado en el arranque siguiente.
    await this.inFlight?.catch(() => false);
  }

  private tick(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<boolean> {
    const published = await this.lease.within(OUTBOX_LEASE, LEASE_TTL_MS, async () => {
      await this.outbox.reconcile(await this.reader.all());
      const entry = await this.outbox.next(new Date(this.clock.now()));
      if (!entry) return false;
      return this.deliver(entry);
    });
    // `undefined` ES "NO LO CONSEGUÍ", y es un desenlace normal: otro proceso está publicando. El tick
    // se saltea en vez de fallar.
    return published ?? false;
  }

  private async deliver(entry: GameModeOutboxEntry): Promise<boolean> {
    try {
      await confirmedWithin(
        this.delivery.publishTopic(GAME_MODE_EXCHANGE, entry.routingKey, entry.payload),
        PUBLISH_TIMEOUT_MS,
      );
    } catch (error) {
      // EL BACKOFF SE CALCULA CON LOS INTENTOS **YA ACUMULADOS**: el primer fallo espera un segundo.
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** entry.attempts);
      await this.outbox.retry(entry.id, String(error), new Date(this.clock.now() + delay));
      this.log.warn("no se pudo publicar el evento del catálogo", {
        id: entry.id,
        routingKey: entry.routingKey,
        attempts: entry.attempts + 1,
        error: String(error),
      });
      return false;
    }
    // SE MARCA DESPUÉS DEL CONFIRM DEL BROKER, que es lo que `publishTopic` promete. Marcar antes
    // daría por entregado un mensaje que el broker nunca tomó, y el evento se perdería sin rastro.
    await this.outbox.sent(entry.id, new Date(this.clock.now()));
    return true;
  }
}

// EL PLAZO, DEL LADO DEL QUE LLAMA. `shared/amqp.ts` no lo acota a propósito —el que sabe cuánto puede
// esperar es el llamador— y acá son cinco segundos. Rechaza en vez de resolver: el desenlace tiene que
// ir al camino de reintento, no darse por bueno.
//
// La promesa original puede no resolverse NUNCA (broker caído), y eso está contemplado: su `then` ya
// tiene manejador, así que un rechazo tardío no queda sin atender.
function confirmedWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // `unref()` para que un plazo pendiente no le impida salir al proceso, igual que en
    // `shared/http/health.ts`.
    const timer: { unref?: () => void } = setTimeout(
      () => reject(new Error(`la publicación no confirmó en ${ms} ms`)),
      ms,
    );
    timer.unref?.();
    work
      .then(resolve, reject)
      .finally(() => clearTimeout(timer as unknown as Parameters<typeof clearTimeout>[0]));
  });
}
