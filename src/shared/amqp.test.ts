import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { AmqpDeliveryError, AmqpPublisher } from "./amqp.js";

// CONTRA UN DOBLE DE `amqplib`, y no contra un RabbitMQ de verdad, por lo mismo que
// `mongo-lease.test.ts` y `mongo-history.test.ts`: la suite del dominó no depende de NINGÚN
// servicio externo y eso es una propiedad del repo y no del shell de quien la corre
// (`vitest.setup.ts` borra `MONGO_URI`/`REDIS_URL` y va a borrar `RABBITMQ_URL`).
//
// El doble se instala con `vi.hoisted` porque la fábrica del `vi.mock` corre ANTES que los imports
// de este archivo: un `const` declarado acá abajo todavía estaría en su zona muerta.
const connect = vi.hoisted(() => vi.fn());
vi.mock("amqplib", () => ({ connect }));

// LOS DOS DOBLES SON `EventEmitter` DE VERDAD, y no objetos con un `on: vi.fn()`. No es cosmética:
// un `emit("error")` sobre un emisor SIN oyentes lanza —es la regla de Node, no de amqplib—, así que
// un publicador que no escuche `error` tumba el proceso. Con un `on` de mentira esa falla sería
// invisible; con el emisor real, el test que dispara `error` se pone rojo solo.
type FakeChannel = EventEmitter & {
  assertExchange: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
};

// El confirm del broker llega OK por default: el último argumento de `publish` es el callback.
const confirmOk = (...args: unknown[]) => {
  (args.at(-1) as (err: unknown) => void)(null);
  return true;
};

function fakeChannel(): FakeChannel {
  return Object.assign(new EventEmitter(), {
    assertExchange: vi.fn().mockResolvedValue({}),
    publish: vi.fn(confirmOk),
  });
}

function fakeLogger(): Logger {
  const self: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => self,
  };
  return self;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// UN TURNO DEL MACROTASK, no un `await Promise.resolve()`: lo que hay que vaciar es una cadena de
// microtasks de largo desconocido (conectar, abrir canal, declarar el exchange). Contar `await`s
// sería un test que se pone verde solo el día que el adaptador agrega uno.
const tick = () => new Promise((resume) => setTimeout(resume, 0));

// Los canales se pre-crean para que un test pueda configurar `publish` ANTES de publicar, y son
// varios para poder medir la reapertura: cada `createConfirmChannel` entrega el siguiente.
function harness() {
  const channels = [fakeChannel(), fakeChannel(), fakeChannel()];
  let created = 0;
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: vi.fn(async () => channels[created++]),
    close: vi.fn(async () => undefined),
  });
  connect.mockResolvedValue(connection);
  return { publisher: new AmqpPublisher("amqp://test", fakeLogger()), connection, channels };
}

const PAYLOAD = { id: "modo-1", name: "Clásico", playerCount: 2 };

const optionsOf = (call: unknown[]) => call[3] as Record<string, unknown>;
const bodyOf = (call: unknown[]) => JSON.parse((call[2] as Buffer).toString());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AmqpPublisher: el protocolo de publicación", () => {
  it("declara el exchange durable de tipo topic ANTES de publicar en él", async () => {
    const { publisher, channels } = harness();

    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);

    expect(channels[0]?.assertExchange).toHaveBeenCalledWith("betaso", "topic", { durable: true });
    // EL ORDEN ES EL CONTRATO, no un detalle: publicar contra un exchange que todavía no existe
    // —el consumidor no arrancó nunca— MATA el canal, y el evento se pierde con el canal.
    expect(Number(channels[0]?.publish.mock.invocationCallOrder[0])).toBeGreaterThan(
      Number(channels[0]?.assertExchange.mock.invocationCallOrder[0]),
    );
  });

  it("manda el cuerpo CRUDO y no el envoltorio `{pattern,data}` de NestJS", async () => {
    const { publisher, channels } = harness();

    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);

    const call = channels[0]?.publish.mock.calls[0] ?? [];
    expect(call[0]).toBe("betaso");
    expect(call[1]).toBe("game_mode.updated");
    // `toEqual` contra el payload entero y no `toMatchObject`: lo que se mide es que NO SOBRE nada.
    // El envoltorio `{pattern, data, id}` es del camino de COLA de v1 —lo consume un `@EventPattern`
    // de NestJS—; este exchange lo lee otro consumidor, y un envoltorio lo deja sin entender el
    // mensaje en silencio (`Betaso-Domino-Backend/src/storage/rabbitmq/publisher.ts:64`).
    expect(bodyOf(call)).toEqual(PAYLOAD);
  });

  it("publica persistente, como JSON y con un messageId propio de cada mensaje", async () => {
    const { publisher, channels } = harness();

    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);
    await publisher.publishTopic("betaso", "game_mode.created", PAYLOAD);

    const first = optionsOf(channels[0]?.publish.mock.calls[0] ?? []);
    const second = optionsOf(channels[0]?.publish.mock.calls[1] ?? []);
    // `toEqual` otra vez por lo mismo: una opción de más acá es una diferencia con lo que v1 ya
    // publica en la misma `betaso`, y este incremento conserva ese contrato.
    expect(first).toEqual({
      persistent: true,
      contentType: "application/json",
      messageId: expect.any(String),
    });
    // DISTINTO EN CADA MENSAJE: la entrega es al menos una vez, así que el `messageId` es lo que le
    // permite a un consumidor deduplicar. Uno fijo convierte dos eventos reales en uno.
    expect(second.messageId).not.toBe(first.messageId);
  });
});

describe("AmqpPublisher: la entrega sólo cuenta si el broker la confirma", () => {
  // LA ASERCIÓN MÁS IMPORTANTE DEL ARCHIVO, y la razón entera de usar un confirm channel. El
  // dispatcher del outbox marca `SENT` cuando esta promesa resuelve: si resolviera con el `publish()`
  // —que sólo dice "lo puse en el buffer de salida"— un mensaje que el broker nunca tomó quedaría
  // marcado como entregado, y el evento se pierde SIN RASTRO y sin reintento.
  it("no resuelve hasta que llega el callback del confirm", async () => {
    const { publisher, channels } = harness();
    let confirm: ((err: unknown) => void) | undefined;
    channels[0]?.publish.mockImplementation((...args: unknown[]) => {
      confirm = args.at(-1) as (err: unknown) => void;
      return true;
    });

    let resolved = false;
    const publishing = publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD).then(() => {
      resolved = true;
    });

    await tick();
    expect(confirm).toBeDefined();
    expect(resolved).toBe(false);

    confirm?.(null);
    await publishing;
    expect(resolved).toBe(true);
  });

  it("un rechazo del broker no es una entrega", async () => {
    const { publisher, channels } = harness();
    channels[0]?.publish.mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (err: unknown) => void)(new Error("nacked"));
      return true;
    });

    await expect(
      publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD),
    ).rejects.toBeInstanceOf(AmqpDeliveryError);
  });

  // `false` ES CONTRAPRESIÓN y no un fallo —el buffer de salida está lleno—, y aun así se RECHAZA.
  // El mensaje puede terminar saliendo, pero quien espera no tiene forma de enterarse: darlo por
  // bueno es exactamente el mismo evento perdido que resolver antes del confirm. El outbox reintenta,
  // y la entrega es al menos una vez por diseño, así que un duplicado es el costo correcto.
  it("el canal lleno tampoco es una entrega", async () => {
    const { publisher, channels } = harness();
    channels[0]?.publish.mockImplementation(() => false);

    await expect(
      publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD),
    ).rejects.toBeInstanceOf(AmqpDeliveryError);
  });

  // NEUTRO Y NO LA EXCEPCIÓN CRUDA de amqplib: el único error que sale de `shared/` tiene que poder
  // traducirlo quien publica, y un `ECONNREFUSED` pelado obligaría a cada llamador a conocer la
  // librería.
  it("no poder conectarse es un fallo de entrega", async () => {
    const { publisher } = harness();
    connect.mockRejectedValue(new Error("sin broker"));

    await expect(
      publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD),
    ).rejects.toBeInstanceOf(AmqpDeliveryError);
  });
});

describe("AmqpPublisher: la conexión y el canal", () => {
  // LANZADAS EN EL MISMO TURNO, sin esperar a que la primera termine, y ése es el punto entero: si se
  // esperara, la segunda encontraría el canal ya guardado y hasta un publicador sin memoización
  // pasaría. Juntas, las dos piden el canal antes de que ninguna lo haya abierto.
  it("dos publicaciones simultáneas abren UNA conexión y UN canal", async () => {
    const { publisher, connection, channels } = harness();

    await Promise.all([
      publisher.publishTopic("betaso", "game_mode.created", PAYLOAD),
      publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD),
    ]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.createConfirmChannel).toHaveBeenCalledTimes(1);
    expect(channels[0]?.publish).toHaveBeenCalledTimes(2);
    expect(channels[1]?.publish).not.toHaveBeenCalled();
  });

  // EL CANAL MUERE CON LA CONEXIÓN —amqplib cierra todos los canales cuando el socket se cae
  // (`lib/connection.js:_closeChannels`)—, así que hay que SOLTARLO. Sin esto, un reinicio del broker
  // deja al proceso publicando para siempre contra un canal cerrado: cada entrega falla y ninguna
  // reabre nada.
  it.each([["close"], ["error"]])(
    "suelta el canal al recibir '%s' y lo reabre en la publicación siguiente",
    async (event) => {
      const { publisher, connection, channels } = harness();
      await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);

      channels[0]?.emit(event, new Error("el canal se cayó"));
      await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);

      expect(connection.createConfirmChannel).toHaveBeenCalledTimes(2);
      expect(channels[1]?.publish).toHaveBeenCalledTimes(1);
      // LA CONEXIÓN NO SE REABRE, y es distinto de lo que hace truco. `connect(url, {recovery:true})`
      // devuelve un `RecoveringChannelModel` que se reconecta SOLO y sin plazo de renuncia
      // (`maxRetries: Infinity`), y sus canales se piden sobre el modelo, no sobre el socket. Llamar
      // `connect()` otra vez abandonaría un modelo que igual sigue reconectándose: un zombi por cada
      // caída del broker.
      expect(connect).toHaveBeenCalledTimes(1);
    },
  );

  // Un `error` de la CONEXIÓN sin oyente tumba el proceso: `RecoveringChannelModel` es un
  // `EventEmitter` y reemite el `error` del modelo de abajo (`lib/recovery.js:221`), y Node lanza
  // cuando un `error` no tiene a quién ir. Un broker que rechaza las credenciales mataría el servidor
  // con todas sus partidas en curso.
  it("un error de la conexión se escucha y no tumba el proceso", async () => {
    const { publisher, connection } = harness();
    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);

    expect(() => connection.emit("error", new Error("credenciales rechazadas"))).not.toThrow();
  });
});

describe("AmqpPublisher: el ciclo de vida", () => {
  // ABRE EL CANAL Y NO PUBLICA NADA. Su llamador es la sonda de LISTO, que corre en cada chequeo del
  // balanceador: si preguntar "¿está Rabbit?" publicara, cada sonda emitiría un evento de catálogo
  // que los consumidores tendrían que deduplicar.
  it("ping abre el canal sin publicar", async () => {
    const { publisher, connection, channels } = harness();

    await publisher.ping();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.createConfirmChannel).toHaveBeenCalledTimes(1);
    expect(channels[0]?.publish).not.toHaveBeenCalled();
    expect(channels[0]?.assertExchange).not.toHaveBeenCalled();
  });

  it("ping propaga como fallo de entrega que el broker no esté", async () => {
    const { publisher } = harness();
    connect.mockRejectedValue(new Error("sin broker"));

    await expect(publisher.ping()).rejects.toBeInstanceOf(AmqpDeliveryError);
  });

  it("cierra la conexión y la publicación siguiente la reabre", async () => {
    const { publisher, connection } = harness();
    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);

    await publisher.close();
    expect(connection.close).toHaveBeenCalledTimes(1);

    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  // EL APAGADO NO PUEDE ROMPERSE POR CERRAR DOS VECES, y está escrito porque ya pasó: cerrar Redis
  // además de Colyseus dejaba una promesa rechazada en CADA apagado (ver AGENTS.md). Acá el orden del
  // apagado llama a `close()` después del dispatcher, y una conexión que el broker ya cortó tiene que
  // salir en silencio.
  it("cerrar dos veces, o sin haber abierto nunca, no falla", async () => {
    const { publisher, connection } = harness();
    await expect(publisher.close()).resolves.toBeUndefined();
    expect(connection.close).not.toHaveBeenCalled();

    await publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);
    connection.close.mockRejectedValue(new Error("Connection closed"));

    await expect(publisher.close()).resolves.toBeUndefined();
    await expect(publisher.close()).resolves.toBeUndefined();
  });

  // EL CIERRE ALCANZA A LA CONEXIÓN QUE SE ESTABA ABRIENDO. Sin esto, un apagado disparado mientras
  // una entrega está conectando deja el socket abierto DESPUÉS del cierre —y con `recovery: true` ese
  // modelo reintenta para siempre—, así que el proceso no termina de salir nunca.
  it("cerrar mientras la conexión está en vuelo tampoco la deja abierta", async () => {
    const { publisher, connection } = harness();
    const opening = deferred<typeof connection>();
    connect.mockReturnValue(opening.promise);

    const publishing = publisher.publishTopic("betaso", "game_mode.updated", PAYLOAD);
    const closing = publisher.close();
    opening.resolve(connection);
    await closing;

    expect(connection.close).toHaveBeenCalledTimes(1);
    await publishing.catch(() => undefined);
  });
});
