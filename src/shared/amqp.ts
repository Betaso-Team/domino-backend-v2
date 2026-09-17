import { randomUUID } from "node:crypto";
import type { Logger } from "@/logger";
import { type ConfirmChannel, type RecoveringChannelModel, connect } from "amqplib";

// LA ENTREGA por cola, sin saber QUÉ entrega. Vive en `shared/` y no dentro de
// `features/game-mode/` por el mismo argumento que `shared/mongo.ts`: `amqplib` es un paquete de
// runtime, su ciclo de vida es del PROCESO —una conexión, un canal, un cierre ordenado— y lo que la
// feature sabe es el CONTRATO (a qué exchange, con qué routing key y con qué campos), que se queda
// del otro lado, en `features/game-mode/events.ts`.
//
// SON DOS FORMAS DE PUBLICAR Y NO SE PUEDEN MEZCLAR, porque el backend principal consume de dos
// maneras distintas:
//
//   publishPattern  → a una COLA, con el envoltorio `{pattern, data, id}` de NestJS, porque del
//                     otro lado lo recibe un `@EventPattern` que despacha por ese `pattern`.
//                     Es el camino del RANKING (`rankings_queue`).
//   publishTopic    → a un EXCHANGE topic, con el payload CRUDO, porque ese consumidor no es un
//                     `@EventPattern` y el envoltorio lo dejaría sin entender el mensaje. Es el
//                     camino del CATÁLOGO (exchange `betaso`).
//
// Mezclarlas produce un mensaje que nadie consume, EN SILENCIO. Los dos contratos son de v1
// (`Betaso-Domino-Backend/src/storage/rabbitmq/publisher.ts`) y se conservan enteros.
//
// `publishPattern` NACIÓ SIN LLAMADOR EN EL INCREMENTO DEL CATÁLOGO y por eso no se escribió
// entonces —un método sin llamador es una segunda forma de publicar que alguien va a elegir mal—.
// Llegó con el ranking, que es su primer consumidor real.
//
// Lo que sigue SIN portarse de truco son los `headers` con la traza en curso, que allá salen de
// `shared/trace.ts`. Acá no hay propagación de trazas todavía, y un header vacío no es
// compatibilidad: es una clave que hay que explicar.
//
// Y con una diferencia que NO es una omisión, medida sobre la `amqplib` 2.0.1 instalada: truco, al
// soltar el canal, vuelve a llamar `connect()`. Con `recovery: true` eso abandona un
// `RecoveringChannelModel` que sigue reconectándose solo para siempre (`maxRetries: Infinity` por
// default, `node_modules/amqplib/lib/recovery.js:8`), o sea un zombi por cada caída del broker. Acá
// la conexión y el canal se memoizan por separado: el canal se suelta, la conexión se reusa.
//
// ⚠ **CON EL BROKER CAÍDO, `connect()` NO RECHAZA: CUELGA**, y eso lo heredan los llamadores de esta
// clase. Ese mismo `maxRetries: Infinity` deja muerta la única rama que rechaza la conexión inicial
// (`_scheduleReconnect` sólo llama `_rejectInitialConnection` cuando se agotaron los reintentos,
// `lib/recovery.js:290-294`), así que la promesa de `connect()` se queda esperando mientras el
// modelo reintenta con backoff. **Acá no se acota, y es deliberado**: el plazo tiene que ser del que
// llama, que es quien sabe cuánto puede esperar. Son dos, y ya existen o están planificados:
//   - la sonda de LISTO, con su plazo POR CHEQUEO de 2 s (`shared/http/health.ts`). Es la misma
//     propiedad que AGENTS.md ya tiene escrita para Mongo: «una base caída no falla: CUELGA».
//   - el dispatcher del outbox (Tarea 7), que publica con un plazo de 5 s y agenda el reintento.
// O sea: **`ping()` no se rechaza solo**. Quien cablee la Tarea 11 no puede asumir que sí — sin el
// plazo del lado del endpoint, un Rabbit caído deja `/ready` sin contestar en vez de contestar 503.

// NO SE PUDO ENTREGAR. Es el único error que sale de acá, y es NEUTRO a propósito: quien publica lo
// traduce al vocabulario de su feature, porque un error que hable de modos de juego no tiene nada
// que hacer en `shared/` — y al revés, un `ECONNREFUSED` crudo de amqplib obligaría a cada llamador
// a conocer la librería para decidir si reintenta.
export class AmqpDeliveryError extends Error {
  constructor(cause: string) {
    super(`no se pudo entregar por la cola: ${cause}`);
    this.name = "AmqpDeliveryError";
  }
}

// LO QUE NECESITA QUIEN PUBLICA, que es menos que el publicador entero: publicar, sin el ciclo de
// vida. El dispatcher del outbox depende de esto y no de la clase —abrir y cerrar la conexión es
// del composition root, no suyo—, y de paso un doble de test no tiene que fingir un `close()` que
// nadie llama.
export interface AmqpDelivery {
  publishPattern(queue: string, pattern: string, data: unknown): Promise<void>;
  publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void>;
}

export class AmqpPublisher implements AmqpDelivery {
  private connection?: RecoveringChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {}

  // A UNA COLA, con el envoltorio de NestJS. Sin él, el `@EventPattern` del otro lado no sabe a qué
  // handler mandarlo y el mensaje se descarta en silencio.
  //
  // LA COLA NO SE DECLARA, y es lo contrario de lo que hace `publishTopic` con su exchange: la cola
  // la crea el microservicio de NestJS, que es su dueño y quien decide sus opciones. v1 tampoco la
  // declara (`publisher.ts`, `sendToQueue` a secas), y declararla desde acá con opciones distintas
  // de las suyas MATA el canal — que es el mismo accidente que el exchange sin declarar, con los
  // papeles al revés.
  async publishPattern(queue: string, pattern: string, data: unknown): Promise<void> {
    const channel = await this.ready();
    const messageId = randomUUID();
    await this.confirm((done) =>
      channel.sendToQueue(
        queue,
        Buffer.from(JSON.stringify({ pattern, data, id: messageId })),
        { persistent: true, contentType: "application/json", messageId },
        done,
      ),
    );
    this.log.debug("publicado a la cola", { messageId, queue, pattern });
  }

  // A UN EXCHANGE TOPIC, con el cuerpo CRUDO. Es el contrato que v1 ya publica en `betaso`
  // (`Betaso-Domino-Backend/src/storage/rabbitmq/publisher.ts:49-68`) y este incremento lo conserva
  // entero: `persistent`, `contentType` y un `messageId` propio de cada mensaje.
  async publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void> {
    const channel = await this.ready();
    // EL EXCHANGE SE DECLARA ANTES DE CADA PUBLICACIÓN, como hace v1: si el consumidor todavía no
    // arrancó, publicar contra un exchange inexistente MATA el canal —y se lleva puestos los
    // confirms pendientes—. Es idempotente y barato; el precio de no hacerlo es un evento perdido.
    await channel.assertExchange(exchange, "topic", { durable: true });
    // EL `messageId` SE NOMBRA acá y es uno por mensaje. La entrega de este incremento es AL MENOS
    // UNA VEZ, así que es lo único que le permite deduplicar al consumidor; y es también lo que
    // permite cruzar las dos mitades de una entrega cuando hay que auditarla.
    const messageId = randomUUID();
    await this.confirm((done) =>
      channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(body)),
        { persistent: true, contentType: "application/json", messageId },
        done,
      ),
    );
    this.log.debug("publicado al exchange", { messageId, exchange, routingKey });
  }

  // ¿CONTESTA? Abre la conexión y el canal, y NO PUBLICA: su único llamador es la sonda de LISTO,
  // que corre en cada chequeo del balanceador. Una sonda que publicara emitiría un evento de
  // catálogo por chequeo, y del otro lado eso es un consumidor deduplicando ruido nuestro.
  //
  // Pasa por el mismo camino perezoso que una entrega a propósito, igual que `Mongo.ping()`: "¿le
  // mando trabajo?" con la conexión sin abrir es exactamente la pregunta que este método contesta.
  async ping(): Promise<void> {
    await this.ready();
  }

  // TOLERA QUE YA ESTÉ CERRADA, y no es defensividad de más: el orden del apagado llama a esto
  // después del dispatcher, y una conexión que el broker ya cortó —o un `close()` repetido— no puede
  // dejar una promesa rechazada en cada apagado. Ese error exacto ya se pagó una vez cerrando Redis
  // dos veces (ver AGENTS.md).
  async close(): Promise<void> {
    // SE ESPERA EL INTENTO EN VUELO antes de soltar nada. Sin esta línea, un apagado disparado
    // mientras una entrega está conectando deja la conexión abriéndose DESPUÉS del cierre, sin nadie
    // que la cierre: con `recovery: true` ese modelo reintenta para siempre y el proceso no termina
    // de salir nunca.
    await this.opening?.catch(() => undefined);
    const connection = this.connection;
    this.connection = undefined;
    this.channel = undefined;
    this.opening = undefined;
    await connection?.close().catch(() => undefined);
  }

  // ESPERA EL CONFIRM DEL BROKER antes de dar la entrega por hecha, y es la razón entera de usar un
  // confirm channel. v1 abre uno y nunca lo espera, así que un mensaje rechazado se pierde sin que
  // nadie se entere. Acá el dispatcher del outbox marca `SENT` cuando esta promesa resuelve:
  // resolver con el `publish()` —que sólo dice "lo puse en el buffer de salida"— sería marcar como
  // entregado algo que el broker nunca tomó.
  private confirm(publish: (done: (err: unknown) => void) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const written = publish((err) =>
        err
          ? reject(new AmqpDeliveryError(`el broker rechazó el mensaje: ${String(err)}`))
          : resolve(),
      );
      // `false` ES CONTRAPRESIÓN —el buffer de salida está lleno—, no un fallo, y AUN ASÍ se rechaza.
      // El mensaje puede terminar saliendo, pero quien espera no tiene cómo enterarse, así que darlo
      // por bueno es el mismo evento perdido que resolver antes del confirm. El outbox reintenta, y
      // la entrega es al menos una vez por diseño: un duplicado es el costo correcto.
      if (!written) reject(new AmqpDeliveryError("el canal no aceptó el mensaje (buffer lleno)"));
    });
  }

  private async ready(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    // UN SOLO INTENTO EN VUELO, y memoiza el INTENTO y no el resultado: sin esto, dos entregas
    // simultáneas al arrancar abren dos conexiones. El `finally` lo limpia también cuando falla, que
    // es lo que hace que un broker caído se pueda reintentar en la entrega siguiente en vez de dejar
    // al proceso pegado a una promesa rechazada para siempre.
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<ConfirmChannel> {
    try {
      // PEREZOSA, igual que Mongo: el proceso arranca aunque el broker no esté, y quien primero
      // necesite entregar paga la espera. `recovery: true` es la reconexión con backoff de la propia
      // librería, en vez de un bucle nuestro.
      this.connection ??= await this.dial();
      const channel = await this.connection.createConfirmChannel();
      // EL CANAL MUERE CON LA CONEXIÓN: amqplib cierra todos los canales cuando el socket se cae
      // (`lib/connection.js`, `_closeChannels`), y el confirm channel resuelve sus callbacks
      // pendientes con un `Error('channel closed')` (`lib/channel.js:36-43`), así que nadie se queda
      // esperando un confirm que ya no va a llegar. Lo que falta es SOLTARLO: sin esto el proceso
      // publicaría para siempre contra un canal cerrado, fallando cada entrega sin reabrir nada.
      const drop = () => {
        if (this.channel === channel) this.channel = undefined;
      };
      channel.on("close", drop);
      channel.on("error", drop);
      this.channel = channel;
      return channel;
    } catch (error) {
      // EL MENSAJE CUBRE LAS DOS MITADES del bloque —conectar y abrir el canal—, porque el `catch`
      // también. Decir "no se pudo conectar" cuando lo que falló fue `createConfirmChannel` manda a
      // soporte a mirar la red con la conexión sana.
      throw new AmqpDeliveryError(
        `no se pudo preparar el canal de confirmaciones: ${String(error)}`,
      );
    }
  }

  private async dial(): Promise<RecoveringChannelModel> {
    const connection = await connect(this.url, { recovery: true });
    // UN OYENTE DE `error` SOBRE LA CONEXIÓN, y no es opcional: `RecoveringChannelModel` es un
    // `EventEmitter` y reemite el `error` del modelo de abajo (`lib/recovery.js:221`, `:375`). Node
    // LANZA cuando un evento `error` no tiene a quién ir, así que sin esta línea ese error tumba el
    // servidor entero, con todas sus partidas en curso.
    //
    // EL CASO ES EL SOCKET QUE SE MUERE DESPUÉS de haberse establecido —el broker que se reinicia, la
    // red que se corta, un heartbeat vencido—, y conviene tenerlo derecho porque el caso que parece
    // obvio NO pasa por acá: un rechazo de credenciales ocurre durante el handshake, o sea adentro
    // del `try` de `_connect()`, y sale por su `catch` como `connect-failed` más un reintento
    // agendado (`lib/recovery.js:275-279`) sin tocar nunca este `error`. Este `emit` es sólo para un
    // modelo YA ENLAZADO (`_bindModel`, `:221`).
    //
    // No se suelta la conexión acá: la recuperación de la librería sigue su curso y el canal ya se
    // suelta solo por su propio `close`.
    connection.on("error", (error) => {
      this.log.warn("la conexión con el broker falló", { error: String(error) });
    });
    return connection;
  }
}
