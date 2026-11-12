import type { Logger } from "@/logger";
import type { AmqpDelivery, TopicPublishOptions } from "./amqp";
import type { Lease } from "./mongo-lease";

// EL OUTBOX DURABLE, LA PARTE QUE NO SABE QUÉ PUBLICA. Nació en el catálogo de modos (que publicaba
// al exchange `betaso` de Betaso, ya eliminado) y hoy su único usuario es el resultado de las
// partidas del orquestador, que necesita estas cuatro propiedades:
//
// 1. **Quien encola nunca espera a Rabbit.** Escribe acá y sigue; el despachador publica después.
// 2. **Una entrada se marca `SENT` solo después del confirm del broker**, dentro de un plazo.
// 3. **Una caída del broker no tiene límite de intentos**: cuesta retraso, no datos. Lo que sí tiene
//    límite es la entrada que falla SOLA (con el broker confirmando a las demás): a los
//    `maxStrikes` fallos así pasa a `PARKED` —nunca se borra, sale en `/ready` y en un `error` con
//    el cuerpo entero— y se reproduce a mano (`docs/operacion.md`, «Resultados estacionados»).
// 4. **Una entrada que falla no traba a las de atrás**: `next()` ofrece el pendiente con MENOS
//    intentos y, entre iguales, el más viejo. Sin fallos es el orden de llegada; una entrada que falló
//    queda detrás de las que todavía no se intentaron. El orden entre partidas distintas no es parte
//    del contrato (el consumidor deduplica por `messageId` y cada partida tiene un solo desenlace).
//
// 5. **Exclusión por desenlace** (`exclusiveKey`): dos entradas con la misma clave exclusiva no
//    conviven, en ningún estado. Los resultados la usan con el `matchId`: una partida publica
//    `finished` O `aborted`, nunca los dos (en Mongo, un índice único parcial; ver `mongo-outbox.ts`).
//
// LA ESPERA ES DEL BROKER, NO DE CADA ENTRADA. Antes cada entrada guardaba su `nextAttemptAt` con un
// backoff de hasta cinco minutos, y como nadie se adelanta, una sola entrada que falló dejaba a toda
// la cola esperando su plazo aunque el broker ya hubiera vuelto: bloqueo de cabeza. Ahora el que
// espera es el despachador (`brokerDownUntil`, con techo de 30 s), cada publicación confirmada lo
// resetea, y quien encola lo despierta ignorando la espera: el broker que volvió se nota con la
// próxima partida que termina, o a los 30 s como mucho.
//
// LA ENTREGA ES AL MENOS UNA VEZ: un proceso que muere entre el confirm y la marca republica, y el
// consumidor deduplica (por `messageId` en los resultados).
//
// Lo que es de cada uso —las claves de deduplicación, el nombre del exchange y del lease— entra por
// parámetro.

// `PARKED`: falló `maxStrikes` veces con el broker sano. No se reintenta sola y no se borra nunca.
export type OutboxStatus = "PENDING" | "SENT" | "PARKED";

// EL RELOJ INYECTADO, estructural como en `mongo-lease.ts`: sin él, medir el backoff exigiría esperar
// de verdad.
export interface OutboxClock {
  now(): number;
}

// LA ENTRADA PORTABLE. `id` es opaco —el adaptador Mongo pone el hex de su `ObjectId`— y es lo único
// que el despachador le devuelve a `sent`/`retry`.
export interface OutboxEntry<K extends string = string, P = unknown> {
  readonly id: string;
  readonly dedupeKey: string;
  // LA CLAVE Y EL CUERPO VIAJAN JUNTOS, persistidos los dos: el publicador no decide ninguno. Separarlos
  // dejaría que una entrada se publique con la clave de otra, y en un topic exchange eso es un mensaje
  // que llega a la cola equivocada sin error de nadie.
  readonly routingKey: K;
  readonly payload: P;
  readonly status: OutboxStatus;
  readonly attempts: number;
  // LOS FALLOS CON EL BROKER SANO: el despachador acababa de confirmar otra publicación y ésta falló
  // igual. Es lo que distingue una entrada envenenada de una caída del broker, y lo que la estaciona.
  readonly strikes?: number;
  // Ver la propiedad 5 de arriba. Ausente en las entradas que no la piden (y en las escritas antes).
  readonly exclusiveKey?: string;
  readonly createdAt: Date;
  readonly sentAt?: Date;
  readonly parkedAt?: Date;
  readonly lastError?: string;
}

// LO QUE SE PERSISTE: la entrada sin su identidad, que la pone el almacén.
export type OutboxRecord<K extends string = string, P = unknown> = Omit<OutboxEntry<K, P>, "id">;

// LO QUE EL DESPACHADOR NECESITA DE UN OUTBOX, y nada más.
export interface OutboxQueue<K extends string = string, P = unknown> {
  // Si hay algo pendiente. Es lo que el despachador pregunta ANTES de tomar el lease, una vez por
  // segundo para siempre: tiene que ser barato (en Mongo, una consulta cubierta por el índice).
  hasPending(): Promise<boolean>;
  // El pendiente con menos intentos y, entre iguales, el más viejo. La espera tras un fallo es del
  // despachador.
  next(): Promise<OutboxEntry<K, P> | undefined>;
  sent(id: string, at: Date): Promise<void>;
  // Anota el fallo: suma un intento (y un `strike` si el broker estaba sano) y guarda el error. No
  // agenda nada.
  retry(id: string, error: string, strike?: boolean): Promise<void>;
  // La saca de la cola para siempre: `PARKED`, con el instante y el motivo. Sólo una PENDING.
  park(id: string, error: string, at: Date): Promise<void>;
}

export interface EnqueueOptions {
  // Ver la propiedad 5: con otra entrada de la misma clave exclusiva, no se inserta.
  readonly exclusiveKey?: string;
}

// LO QUE UN ALMACÉN DE OUTBOX SABE HACER, que es la cola más encolar y preguntar por claves. Lo
// implementan `MemoryOutboxStore` (abajo) y `MongoOutboxStore` (`mongo-outbox.ts`).
export interface OutboxStore<K extends string = string, P = unknown> extends OutboxQueue<K, P> {
  // IDEMPOTENTE POR `dedupeKey`: encolar dos veces la misma clave deja una sola entrada. Devuelve si
  // insertó. Cualquier fallo que no sea "ya estaba" sube.
  // También devuelve `false` si otra entrada tiene la misma `exclusiveKey`: `present` dice cuál.
  enqueue(dedupeKey: string, routingKey: K, payload: P, options?: EnqueueOptions): Promise<boolean>;
  // Cuáles de estas claves ya existen, en cualquier estado.
  present(keys: readonly string[]): Promise<ReadonlySet<string>>;
  // El estado de cada una de estas claves que exista. Rechaza si la base no contesta.
  statuses(keys: readonly string[]): Promise<ReadonlyMap<string, OutboxStatus>>;
  // Cuántas hay estacionadas: lo que `/ready` informa.
  parkedCount(): Promise<number>;
}

// Quince segundos, el del escritor del catálogo. No se renueva (ver `mongo-lease.ts`), y la
// contramedida es que adentro no vaya un trabajo largo: UNA entrada por adquisición.
const LEASE_TTL_MS = 15_000;

// UN TICK POR SEGUNDO. Es el piso de latencia de lo que nadie despertó —un reintento tras un fallo—;
// el camino normal no lo espera porque quien encola llama `wake()`. Con la cola vacía, el tick es UNA
// consulta (`hasPending`) y no toca el lease: el lease de Mongo escribe dos veces por adquisición.
const TICK_MS = 1_000;

// EL PLAZO DE LA PUBLICACIÓN, Y NO ES DECORACIÓN. `AmqpPublisher.publishTopic` **no rechaza solo con
// el broker caído: se cuelga** —`connect()` con `recovery: true` reintenta para siempre—. Sin este
// plazo, el primer tick contra un Rabbit apagado se queda esperando con el lease tomado y el outbox
// deja de drenar sin un solo error en el log.
const PUBLISH_TIMEOUT_MS = 5_000;

// EL BACKOFF DEL BROKER: duplica desde un segundo con cada fallo SEGUIDO y se corta en 30 s. Cada
// publicación confirmada lo vuelve a cero. **SIN LÍMITE DE INTENTOS**: un evento descartado al intento
// N es una pérdida silenciosa. El techo es bajo a propósito: es el peor retraso de un resultado una vez
// que el broker volvió, si nadie despierta al despachador.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface TopicOutboxDispatcherOptions<K extends string, P> {
  readonly exchange: string;
  // EL NOMBRE DEL LEASE, UNO POR OUTBOX: un solo despachador publica cada outbox en todo el
  // despliegue, porque dos a la vez entregan la misma entrada dos veces. Dos outbox distintos con el
  // mismo nombre se bloquearían entre sí sin motivo.
  readonly leaseName: string;
  readonly queue: OutboxQueue<K, P>;
  readonly delivery: AmqpDelivery;
  readonly lease: Lease;
  readonly clock: OutboxClock;
  readonly log: Logger;
  // Qué publica, para el log: "resultado de partida".
  readonly label: string;
  readonly publishOptions?: (entry: OutboxEntry<K, P>) => TopicPublishOptions;
  // Cuántas entradas publica un tick como máximo, cada una con su propio lease. Los resultados de
  // partida, que llegan en ráfagas, publican más de una.
  readonly perTick?: number;
  // Desde cuánto sin salir una entrada deja de ser un `warn` y pasa a ser un `error` en cada fallo: un
  // broker que se reinicia es normal, un resultado que lleva diez minutos sin salir es un premio que
  // un jugador va a reclamar. Sin él, todo fallo es un `warn`.
  readonly stuckAfterMs?: number;
  // A cuántos fallos CON EL BROKER SANO se estaciona una entrada (default `DEFAULT_MAX_STRIKES`).
  readonly maxStrikes?: number;
}

// CINCO fallos con el broker sano: una entrada que el broker devuelve cuando a las demás las confirma.
// Una caída del broker suma como mucho UN strike por caída (el primer fallo, con `failures` en cero),
// y la entrada que lo recibió pasa al fondo de la cola, así que la próxima caída golpea a otra.
export const DEFAULT_MAX_STRIKES = 5;

// EL DESPACHADOR. Un tick = hasta `perTick` vueltas de un lease, el trabajo previo y UNA entrada.
export class TopicOutboxDispatcher<K extends string, P> {
  private timer?: ReturnType<typeof setInterval>;
  // LA GUARDA DE CONCURRENCIA ES SUYA Y NO DEL LEASE: `MongoLease` excluye PROCESOS y no llamadas, así
  // que sin esta promesa compartida un `wake()` encima del tick programado publica la misma entrada
  // dos veces.
  private inFlight?: Promise<boolean>;
  // UN `wake()` QUE LLEGÓ CON UN TICK EN VUELO: ese tick pudo haber salido por la ventana sin mirar la
  // cola, así que al terminar se sondea otra vez. Sin esto, el resultado encolado justo ahí esperaría
  // la ventana entera.
  private wokenInFlight = false;
  private closed = false;
  // LA VENTANA DEL BROKER CAÍDO: hasta este instante el tick programado no toca Mongo ni Rabbit.
  private brokerDownUntil = 0;
  // Fallos SEGUIDOS de publicación, el exponente del backoff.
  private failures = 0;

  constructor(private readonly options: TopicOutboxDispatcherOptions<K, P>) {}

  start(): void {
    if (this.timer || this.closed) return;
    const timer = setInterval(() => {
      this.run(false);
    }, TICK_MS);
    // DESREFERENCIADO: un intervalo referenciado mantiene vivo el event loop.
    timer.unref?.();
    this.timer = timer;
  }

  // ADELANTA EL TICK tras encolar, IGNORANDO LA VENTANA del broker caído: sondea una vez, y si el
  // broker volvió, publica todo lo que estaba esperando. No devuelve promesa a propósito: quien encola
  // no espera a Rabbit.
  wake(): void {
    this.run(true);
  }

  private run(ignoreWindow: boolean): void {
    void this.tick(ignoreWindow).catch((error: unknown) => {
      // SE REGISTRA Y NO SE PROPAGA: una promesa rechazada sin manejador tumba el proceso.
      this.options.log.error(`el tick del outbox (${this.options.label}) falló`, {
        error: String(error),
      });
    });
  }

  // VACÍA LO PENDIENTE mientras el broker confirme; respeta la ventana, como el tick programado. El
  // bucle está AFUERA del lease: adentro iría un trabajo de duración desconocida contra un lease que
  // no se renueva.
  async drain(): Promise<void> {
    let published = true;
    while (published) {
      published = await this.tick(false);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // SE ESPERA EL TICK EN VUELO: sin esto el apagado le cierra la conexión por debajo a una entrega
    // que estaba confirmando, y la marca de entregado no llega nunca.
    await this.inFlight?.catch(() => false);
  }

  private tick(ignoreWindow: boolean): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.inFlight) {
      if (ignoreWindow) this.wokenInFlight = true;
      return this.inFlight;
    }
    this.inFlight = this.runTick(ignoreWindow).finally(() => {
      this.inFlight = undefined;
      if (this.wokenInFlight) {
        this.wokenInFlight = false;
        this.wake();
      }
    });
    return this.inFlight;
  }

  private async runTick(ignoreWindow: boolean): Promise<boolean> {
    // DENTRO DE LA VENTANA EL TICK NO HACE NADA: ni Mongo, ni lease, ni Rabbit.
    if (!ignoreWindow && this.options.clock.now() < this.brokerDownUntil) return false;
    const perTick = this.options.perTick ?? 1;
    let published = false;
    for (let round = 0; round < perTick && !this.closed; round += 1) {
      if (!(await this.runOnce())) break;
      published = true;
    }
    return published;
  }

  private async runOnce(): Promise<boolean> {
    const { lease, leaseName, queue } = this.options;
    // LA PREGUNTA BARATA, ANTES DEL LEASE: con la cola vacía —casi siempre— el tick es una consulta
    // cubierta y nada más.
    if (!(await queue.hasPending())) return false;
    const published = await lease.within(leaseName, LEASE_TTL_MS, async () => {
      // SE RELEE ADENTRO: entre la pregunta y el lease, otro proceso pudo haberla publicado.
      const entry = await queue.next();
      if (!entry) return false;
      return this.deliver(entry);
    });
    // `undefined` ES "NO LO CONSEGUÍ": otro proceso está publicando. El tick se saltea.
    return published ?? false;
  }

  private async deliver(entry: OutboxEntry<K, P>): Promise<boolean> {
    const { delivery, exchange, queue, clock, log, label, publishOptions } = this.options;
    try {
      await confirmedWithin(
        delivery.publishTopic(exchange, entry.routingKey, entry.payload, publishOptions?.(entry)),
        PUBLISH_TIMEOUT_MS,
      );
    } catch (error) {
      // EL BACKOFF ES DEL BROKER, por fallos SEGUIDOS de este proceso: el primero espera un segundo.
      // UN STRIKE si el broker venía sano (cero fallos seguidos): la entrada falló sola.
      const strike = this.failures === 0;
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.failures);
      this.failures += 1;
      this.brokerDownUntil = clock.now() + delay;
      await queue.retry(entry.id, String(error), strike);
      const strikes = (entry.strikes ?? 0) + (strike ? 1 : 0);
      if (strikes >= (this.options.maxStrikes ?? DEFAULT_MAX_STRIKES)) {
        await queue.park(entry.id, String(error), new Date(clock.now()));
        // EL CUERPO ENTERO, para poder reproducirlo aunque la base se pierda. Nunca se borra de la cola.
        log.error(`${label} estacionado: falló ${strikes} veces con el broker sano`, {
          id: entry.id,
          dedupeKey: entry.dedupeKey,
          routingKey: entry.routingKey,
          payload: entry.payload,
          error: String(error),
        });
        return false;
      }
      const pendingMs = clock.now() - entry.createdAt.getTime();
      const detail = {
        id: entry.id,
        routingKey: entry.routingKey,
        attempts: entry.attempts + 1,
        pendingMs,
        error: String(error),
      };
      const stuck = this.options.stuckAfterMs;
      if (stuck !== undefined && pendingMs >= stuck) {
        log.error(`el ${label} lleva demasiado sin salir`, detail);
      } else {
        log.warn(`no se pudo publicar el ${label}`, detail);
      }
      return false;
    }
    // SE MARCA DESPUÉS DEL CONFIRM DEL BROKER: marcar antes daría por entregado un mensaje que el
    // broker nunca tomó.
    // EL BROKER CONFIRMÓ: la ventana se cierra.
    this.failures = 0;
    this.brokerDownUntil = 0;
    await queue.sent(entry.id, new Date(clock.now()));
    return true;
  }
}

// EL PLAZO, DEL LADO DEL QUE LLAMA. Rechaza en vez de resolver: el desenlace tiene que ir al camino de
// reintento. La promesa original puede no resolverse NUNCA (broker caído), y su `then` ya tiene
// manejador, así que un rechazo tardío no queda sin atender.
export function confirmedWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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

// La entrada guardada, sin los `readonly`: el puerto promete inmutabilidad hacia afuera y el almacén
// tiene que poder escribir.
type StoredEntry<K extends string, P> = {
  -readonly [F in keyof OutboxEntry<K, P>]: OutboxEntry<K, P>[F];
};

// EL ALMACÉN DE LA INSTANCIA SIN MONGO, y NO un doble de test: la presencia de `MONGO_URI` elige, y sin
// ella lo encolado vive en memoria. Lo que se pierde es la durabilidad y nada más: el orden, la
// deduplicación y el no-adelantarse son los mismos que en Mongo.
export class MemoryOutboxStore<K extends string = string, P = unknown>
  implements OutboxStore<K, P>
{
  // EN ORDEN DE INSERCIÓN, que es lo que el adaptador Mongo obtiene ordenando por `_id`.
  private readonly entries: StoredEntry<K, P>[] = [];
  private readonly keys = new Set<string>();
  private readonly exclusive = new Set<string>();
  private sequence = 0;

  constructor(private readonly clock: OutboxClock) {}

  async enqueue(
    dedupeKey: string,
    routingKey: K,
    payload: P,
    options: EnqueueOptions = {},
  ): Promise<boolean> {
    const { exclusiveKey } = options;
    if (this.keys.has(dedupeKey)) return false;
    if (exclusiveKey !== undefined && this.exclusive.has(exclusiveKey)) return false;
    const now = new Date(this.clock.now());
    this.sequence += 1;
    this.keys.add(dedupeKey);
    if (exclusiveKey !== undefined) this.exclusive.add(exclusiveKey);
    this.entries.push({
      id: String(this.sequence),
      dedupeKey,
      routingKey,
      payload,
      status: "PENDING",
      attempts: 0,
      strikes: 0,
      ...(exclusiveKey === undefined ? {} : { exclusiveKey }),
      createdAt: now,
    });
    return true;
  }

  async statuses(keys: readonly string[]): Promise<ReadonlyMap<string, OutboxStatus>> {
    return new Map(
      this.entries
        .filter((entry) => keys.includes(entry.dedupeKey))
        .map((entry) => [entry.dedupeKey, entry.status] as const),
    );
  }

  async parkedCount(): Promise<number> {
    return this.entries.filter((entry) => entry.status === "PARKED").length;
  }

  async present(keys: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(keys.filter((key) => this.keys.has(key)));
  }

  async hasPending(): Promise<boolean> {
    return this.entries.some((entry) => entry.status === "PENDING");
  }

  async next(): Promise<OutboxEntry<K, P> | undefined> {
    // EL DE MENOS INTENTOS y, entre iguales, el más viejo (el orden de inserción): `(attempts, _id)`.
    let best: StoredEntry<K, P> | undefined;
    for (const entry of this.entries) {
      if (entry.status !== "PENDING") continue;
      if (!best || entry.attempts < best.attempts) best = entry;
    }
    return best && { ...best };
  }

  async sent(id: string, at: Date): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry) return;
    entry.status = "SENT";
    entry.sentAt = at;
  }

  async retry(id: string, error: string, strike = false): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry) return;
    // SE ACUMULA, no se reescribe.
    entry.attempts += 1;
    if (strike) entry.strikes = (entry.strikes ?? 0) + 1;
    entry.lastError = error;
  }

  async park(id: string, error: string, at: Date): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry || entry.status !== "PENDING") return;
    entry.status = "PARKED";
    entry.parkedAt = at;
    entry.lastError = error;
  }
}
