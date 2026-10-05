import type { Logger } from "@/logger";
import type { AmqpDelivery, TopicPublishOptions } from "./amqp";
import type { Lease } from "./mongo-lease";

// EL OUTBOX DURABLE, LA PARTE QUE NO SABE QUÉ PUBLICA. Nació en el catálogo
// (`features/game-mode/outbox.ts`) y se extrajo cuando apareció el segundo usuario —el resultado de
// las partidas del orquestador—, que necesita exactamente las mismas cuatro propiedades:
//
// 1. **Quien encola nunca espera a Rabbit.** Escribe acá y sigue; el despachador publica después.
// 2. **Una entrada se marca `SENT` solo después del confirm del broker**, dentro de un plazo.
// 3. **No hay límite de intentos**: una caída larga del broker cuesta retraso, no datos.
// 4. **No se adelanta**: `next()` no ofrece la segunda entrada mientras la primera espera su
//    reintento. En el catálogo eso evita aplicar un `updated` viejo encima de uno nuevo; en los
//    resultados, mantiene el orden en que las partidas terminaron.
//
// LA ENTREGA ES AL MENOS UNA VEZ: un proceso que muere entre el confirm y la marca republica, y el
// consumidor deduplica (por `id` en el catálogo, por `messageId` en los resultados).
//
// Lo que es de cada uso —las claves de deduplicación, la reconciliación del catálogo, el nombre del
// exchange y del lease— entra por parámetro.

export type OutboxStatus = "PENDING" | "SENT";

// EL RELOJ INYECTADO, estructural como en `mongo-lease.ts`: sin él, medir el backoff exigiría esperar
// cinco minutos de verdad.
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
  readonly createdAt: Date;
  readonly nextAttemptAt: Date;
  readonly sentAt?: Date;
  readonly lastError?: string;
}

// LO QUE SE PERSISTE: la entrada sin su identidad, que la pone el almacén.
export type OutboxRecord<K extends string = string, P = unknown> = Omit<OutboxEntry<K, P>, "id">;

// LO QUE EL DESPACHADOR NECESITA DE UN OUTBOX, y nada más.
export interface OutboxQueue<K extends string = string, P = unknown> {
  // El pendiente más viejo, SI YA LE TOCA. Devuelve vacío —y no el siguiente— cuando el más viejo
  // todavía espera su reintento.
  next(now: Date): Promise<OutboxEntry<K, P> | undefined>;
  sent(id: string, at: Date): Promise<void>;
  retry(id: string, error: string, nextAttemptAt: Date): Promise<void>;
}

// LO QUE UN ALMACÉN DE OUTBOX SABE HACER, que es la cola más encolar y preguntar por claves. Lo
// implementan `MemoryOutboxStore` (abajo) y `MongoOutboxStore` (`mongo-outbox.ts`), y lo mide el
// mismo contrato contra los dos (`tests/outbox-store-contract.ts`).
export interface OutboxStore<K extends string = string, P = unknown> extends OutboxQueue<K, P> {
  // IDEMPOTENTE POR `dedupeKey`: encolar dos veces la misma clave deja una sola entrada. Devuelve si
  // insertó. Cualquier fallo que no sea "ya estaba" sube.
  enqueue(dedupeKey: string, routingKey: K, payload: P): Promise<boolean>;
  // Cuáles de estas claves ya existen, en cualquier estado.
  present(keys: readonly string[]): Promise<ReadonlySet<string>>;
}

// Quince segundos, el del escritor del catálogo. No se renueva (ver `mongo-lease.ts`), y la
// contramedida es que adentro no vaya un trabajo largo: UNA entrada por adquisición.
const LEASE_TTL_MS = 15_000;

// UN TICK POR SEGUNDO. Es el piso de latencia de lo que nadie despertó —un reintento vencido—; el
// camino normal no lo espera porque quien encola llama `wake()`.
const TICK_MS = 1_000;

// EL PLAZO DE LA PUBLICACIÓN, Y NO ES DECORACIÓN. `AmqpPublisher.publishTopic` **no rechaza solo con
// el broker caído: se cuelga** —`connect()` con `recovery: true` reintenta para siempre—. Sin este
// plazo, el primer tick contra un Rabbit apagado se queda esperando con el lease tomado y el outbox
// deja de drenar sin un solo error en el log.
const PUBLISH_TIMEOUT_MS = 5_000;

// EL BACKOFF: duplica desde un segundo y se corta en cinco minutos. **SIN LÍMITE DE INTENTOS**: un
// evento descartado al intento N es una pérdida silenciosa.
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

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
  // Qué publica, para el log: "evento del catálogo", "resultado de partida".
  readonly label: string;
  // Trabajo del uso antes de buscar la entrada, adentro del lease (la reconciliación del catálogo).
  readonly beforeEach?: () => Promise<void>;
  readonly publishOptions?: (entry: OutboxEntry<K, P>) => TopicPublishOptions;
  // Cuántas entradas publica un tick como máximo, cada una con su propio lease. El catálogo publica
  // una; los resultados de partida, que llegan en ráfagas, más.
  readonly perTick?: number;
}

// EL DESPACHADOR. Un tick = hasta `perTick` vueltas de un lease, el trabajo previo y UNA entrada.
export class TopicOutboxDispatcher<K extends string, P> {
  private timer?: ReturnType<typeof setInterval>;
  // LA GUARDA DE CONCURRENCIA ES SUYA Y NO DEL LEASE: `MongoLease` excluye PROCESOS y no llamadas, así
  // que sin esta promesa compartida un `wake()` encima del tick programado publica la misma entrada
  // dos veces.
  private inFlight?: Promise<boolean>;
  private closed = false;

  constructor(private readonly options: TopicOutboxDispatcherOptions<K, P>) {}

  start(): void {
    if (this.timer || this.closed) return;
    const timer = setInterval(() => {
      this.wake();
    }, TICK_MS);
    // DESREFERENCIADO: un intervalo referenciado mantiene vivo el event loop.
    timer.unref?.();
    this.timer = timer;
  }

  // ADELANTA EL TICK tras encolar. No devuelve promesa a propósito: quien encola no espera a Rabbit.
  wake(): void {
    void this.tick().catch((error: unknown) => {
      // SE REGISTRA Y NO SE PROPAGA: una promesa rechazada sin manejador tumba el proceso.
      this.options.log.error(`el tick del outbox (${this.options.label}) falló`, {
        error: String(error),
      });
    });
  }

  // VACÍA LO QUE YA VENCIÓ. El bucle está AFUERA del lease: adentro iría un trabajo de duración
  // desconocida contra un lease que no se renueva.
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
    // SE ESPERA EL TICK EN VUELO: sin esto el apagado le cierra la conexión por debajo a una entrega
    // que estaba confirmando, y la marca de entregado no llega nunca.
    await this.inFlight?.catch(() => false);
  }

  private tick(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.inFlight ??= this.runTick().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runTick(): Promise<boolean> {
    const perTick = this.options.perTick ?? 1;
    let published = false;
    for (let round = 0; round < perTick && !this.closed; round += 1) {
      if (!(await this.runOnce())) break;
      published = true;
    }
    return published;
  }

  private async runOnce(): Promise<boolean> {
    const { lease, leaseName, queue, clock, beforeEach } = this.options;
    const published = await lease.within(leaseName, LEASE_TTL_MS, async () => {
      await beforeEach?.();
      const entry = await queue.next(new Date(clock.now()));
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
      // EL BACKOFF SE CALCULA CON LOS INTENTOS **YA ACUMULADOS**: el primer fallo espera un segundo.
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** entry.attempts);
      await queue.retry(entry.id, String(error), new Date(clock.now() + delay));
      log.warn(`no se pudo publicar el ${label}`, {
        id: entry.id,
        routingKey: entry.routingKey,
        attempts: entry.attempts + 1,
        error: String(error),
      });
      return false;
    }
    // SE MARCA DESPUÉS DEL CONFIRM DEL BROKER: marcar antes daría por entregado un mensaje que el
    // broker nunca tomó.
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
// deduplicación y el no-adelantarse son los mismos que en Mongo, y lo mide el contrato compartido.
export class MemoryOutboxStore<K extends string = string, P = unknown>
  implements OutboxStore<K, P>
{
  // EN ORDEN DE INSERCIÓN, que es lo que el adaptador Mongo obtiene ordenando por `_id`.
  private readonly entries: StoredEntry<K, P>[] = [];
  private readonly keys = new Set<string>();
  private sequence = 0;

  constructor(private readonly clock: OutboxClock) {}

  async enqueue(dedupeKey: string, routingKey: K, payload: P): Promise<boolean> {
    if (this.keys.has(dedupeKey)) return false;
    const now = new Date(this.clock.now());
    this.sequence += 1;
    this.keys.add(dedupeKey);
    this.entries.push({
      id: String(this.sequence),
      dedupeKey,
      routingKey,
      payload,
      status: "PENDING",
      attempts: 0,
      createdAt: now,
      // NACE VENCIDA: el primer intento es AHORA.
      nextAttemptAt: now,
    });
    return true;
  }

  async present(keys: readonly string[]): Promise<ReadonlySet<string>> {
    return new Set(keys.filter((key) => this.keys.has(key)));
  }

  async next(now: Date): Promise<OutboxEntry<K, P> | undefined> {
    const oldest = this.entries.find((entry) => entry.status === "PENDING");
    // SI EL MÁS VIEJO TODAVÍA NO VENCIÓ, NO SE OFRECE EL SIGUIENTE: la regla de no adelantarse.
    if (!oldest || oldest.nextAttemptAt.getTime() > now.getTime()) return undefined;
    return { ...oldest };
  }

  async sent(id: string, at: Date): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry) return;
    entry.status = "SENT";
    entry.sentAt = at;
  }

  async retry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry) return;
    // SE ACUMULA, no se reescribe: el backoff del despachador se calcula con este número.
    entry.attempts += 1;
    entry.lastError = error;
    entry.nextAttemptAt = nextAttemptAt;
  }
}
