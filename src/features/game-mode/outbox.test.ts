import type { Logger } from "@/logger.js";
import type { AmqpDelivery } from "@/shared/amqp.js";
import { type Lease, MemoryLease } from "@/shared/mongo-lease.js";
import { describe, expect, it, vi } from "vitest";
import type { GameModeReader } from "./core/catalog.js";
import type { GameMode } from "./core/game-mode.js";
import type { GameModePayload } from "./events.js";
import { OutboxDispatcher } from "./outbox.js";
import { MemoryGameModeOutbox } from "./transports/memory-outbox.js";
import { clasica } from "./transports/tests/outbox-contract.js";
import { BASE_INSTANT, mutableClock } from "./transports/tests/repository-contract.js";

// EL DISPATCHER, MEDIDO CONTRA EL OUTBOX DE MEMORIA Y NO CONTRA UN DOBLE DEL PUERTO. El outbox de
// memoria es un adaptador que se despliega —la instancia sin `MONGO_URI` usa ése—, así que medir
// contra él mide el sistema; un doble con `next: vi.fn()` mediría que el dispatcher llama a los
// métodos que el propio test le enseñó a devolver, y las dos reglas que importan acá —no adelantarse
// y no perder— viven justamente en el ida y vuelta entre los dos.

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

interface Published {
  readonly exchange: string;
  readonly routingKey: string;
  readonly body: GameModePayload;
}

function recordingDelivery() {
  const published: Published[] = [];
  let failure: Error | undefined;
  let gate: Promise<void> | undefined;
  return {
    published,
    fails(error = new Error("el broker rechazó el mensaje")) {
      failure = error;
    },
    recovers() {
      failure = undefined;
      gate = undefined;
    },
    // CUELGA, que es lo que de verdad hace `AmqpPublisher` con el broker caído: `connect()` no
    // rechaza —`maxRetries: Infinity`— y la promesa se queda esperando. Ver la cabecera de
    // `shared/amqp.ts`.
    hangsOn(promise: Promise<void> = new Promise<void>(() => {})) {
      gate = promise;
    },
    port: {
      async publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void> {
        published.push({ exchange, routingKey, body: body as GameModePayload });
        if (gate) await gate;
        if (failure) throw failure;
      },
      // EL CATÁLOGO NO PUBLICA A COLAS, y el doble lo dice reventando en vez de no hacer nada: un
      // `async () => {}` acá dejaría pasar en silencio el día que alguien mande un evento de
      // catálogo por el camino equivocado — que es el accidente que `shared/amqp.ts` documenta.
      async publishPattern(): Promise<void> {
        throw new Error("el outbox del catálogo publica al exchange, no a una cola");
      },
    } satisfies AmqpDelivery,
  };
}

// El catálogo que el reconciliador mira. Devuelve `all()` —activos e inactivos— porque un modo dado
// de baja cuyo `updated` se perdió tiene que poder recuperarse igual: si sólo se reconciliara lo
// activo, el consumidor se quedaría mostrando para siempre un modo que el panel retiró.
function readerOf(modes: readonly GameMode[]): GameModeReader {
  return {
    async active() {
      return modes.filter((mode) => mode.isActive);
    },
    async all() {
      return modes;
    },
    async activeByUuid(uuid: string) {
      return modes.find((mode) => mode.uuid === uuid && mode.isActive);
    },
    async byUuid(uuid: string) {
      return modes.find((mode) => mode.uuid === uuid);
    },
  };
}

function recordingLease() {
  const taken: Array<{ name: string; ttlMs: number }> = [];
  const lease: Lease = {
    async within(name, ttlMs, work) {
      taken.push({ name, ttlMs });
      return work();
    },
  };
  return { taken, lease };
}

// EL LEASE NEGADO SE ESCRIBE A MANO Y NO SE USA `MemoryLease`, y es la trampa de este archivo:
// `MemoryLease` es pasa-manos y CORRE SIEMPRE —es la semántica correcta para un proceso que no
// tiene a quién excluir—, así que con él la rama de "no lo conseguí" no se puede alcanzar.
const deniedLease: Lease = {
  async within() {
    return undefined;
  },
};

// UN SOLO LEASE COMPARTIDO POR DOS DISPATCHERS, que es la forma de la competencia real: el que lo
// tiene trabaja, el otro se saltea el tick en vez de esperar. Lo devuelve `undefined`, igual que
// `MongoLease` cuando el `findOneAndUpdate` choca con el E11000.
function contestedLease(): Lease {
  let held = false;
  return {
    async within(_name, _ttlMs, work) {
      if (held) return undefined;
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
  };
}

function fixture(options: { modes?: readonly GameMode[]; lease?: Lease } = {}) {
  const clock = mutableClock();
  const outbox = new MemoryGameModeOutbox(clock);
  const delivery = recordingDelivery();
  const log = fakeLogger();
  const dispatcher = new OutboxDispatcher(
    readerOf(options.modes ?? []),
    outbox,
    delivery.port,
    options.lease ?? new MemoryLease(),
    clock,
    log,
  );
  return { clock, outbox, delivery, log, dispatcher };
}

// Muy después de cualquier reintento agendado: sirve para MIRAR la entrada sin que su plazo la
// esconda. `next()` devuelve vacío cuando todavía no le toca, que es justamente la regla bajo prueba.
const WHENEVER = new Date(BASE_INSTANT + 3_600_000);

describe("OutboxDispatcher: la entrega", () => {
  it("publica la entrada pendiente al exchange de v1 y la marca entregada", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    await outbox.enqueueCreated(clasica());

    await dispatcher.drain();

    // El exchange y la clave se asertan como LITERAL: son lo que un consumidor tiene bindeado en su
    // cola, y comparar contra la constante mediría la constante consigo misma.
    expect(delivery.published).toEqual([
      {
        exchange: "betaso",
        routingKey: "game_mode.created",
        body: {
          id: "mode-1",
          game: "domino",
          name: "Clásica",
          isActive: true,
          prize: 18,
          entryFee: 10,
          multiplier: 2,
          pointsToWin: 25,
          playerCount: 2,
        },
      },
    ]);
    expect(await outbox.next(WHENEVER)).toBeUndefined();
  });

  // UNA ENTRADA POR LEASE Y NO UN BUCLE ADENTRO. El lease no se renueva (ver `shared/mongo-lease.ts`):
  // un bucle que vaciara la cola adentro de una sola adquisición podría pasarse de los 15 s y dejar a
  // otro proceso publicando en paralelo sin que ninguno de los dos se entere.
  it("toma el lease del publicador una vez por entrada", async () => {
    const { taken, lease } = recordingLease();
    const { dispatcher, outbox } = fixture({ lease });
    await outbox.enqueueCreated(clasica());
    await outbox.ensureUpdated(clasica({ uuid: "mode-2", name: "Rápida", version: 1 }));

    await dispatcher.drain();

    // Dos entregas y el tick vacío que cierra el drenaje: tres adquisiciones, una por entrada.
    expect(taken).toEqual([
      { name: "outbox-publisher", ttlMs: 15_000 },
      { name: "outbox-publisher", ttlMs: 15_000 },
      { name: "outbox-publisher", ttlMs: 15_000 },
    ]);
  });

  it("sin el lease no publica ni toca la entrada", async () => {
    const { dispatcher, outbox, delivery } = fixture({ lease: deniedLease });
    await outbox.enqueueCreated(clasica());

    await dispatcher.drain();

    expect(delivery.published).toEqual([]);
    expect(await outbox.next(WHENEVER)).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  // DOS DISPATCHERS COMPITIENDO. Se lanzan EN EL MISMO TURNO a propósito: esperar a que el primero
  // termine dejaría pasar verde a un dispatcher sin lease, que es justo lo que este test prohíbe.
  it("dos dispatchers compitiendo publican sólo desde el que tomó el lease", async () => {
    const clock = mutableClock();
    const outbox = new MemoryGameModeOutbox(clock);
    const lease = contestedLease();
    const uno = recordingDelivery();
    const otro = recordingDelivery();
    const reader = readerOf([]);
    const primero = new OutboxDispatcher(reader, outbox, uno.port, lease, clock, fakeLogger());
    const segundo = new OutboxDispatcher(reader, outbox, otro.port, lease, clock, fakeLogger());
    await outbox.enqueueCreated(clasica());

    await Promise.all([primero.drain(), segundo.drain()]);

    expect(uno.published).toHaveLength(1);
    expect(otro.published).toHaveLength(0);
  });

  // EL LEASE EXCLUYE PROCESOS, NO LLAMADAS DEL MISMO PROCESO (ver el comentario del `owner` en
  // `shared/mongo-lease.ts`), así que el dispatcher necesita su propia guarda: sin ella, un `wake()`
  // que cae encima de un tick programado publica la misma entrada dos veces.
  it("dos ticks del mismo proceso no se solapan", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    await outbox.enqueueCreated(clasica());

    await Promise.all([dispatcher.drain(), dispatcher.drain()]);

    expect(delivery.published).toHaveLength(1);
  });
});

describe("OutboxDispatcher: el fallo y el reintento", () => {
  it("un fallo agenda el reintento y no marca entregado", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    delivery.fails(new Error("el broker rechazó el mensaje"));
    await outbox.enqueueCreated(clasica());

    await dispatcher.drain();

    expect(await outbox.next(WHENEVER)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      nextAttemptAt: new Date(BASE_INSTANT + 1_000),
      lastError: expect.stringContaining("el broker rechazó el mensaje"),
    });
  });

  // EL BACKOFF, ESCRITO COMO LISTA. Duplica desde un segundo y se corta en cinco minutos: sin el
  // techo, doce fallos seguidos dejan el próximo intento a más de un día, o sea el catálogo
  // desincronizado hasta que alguien lo note a mano. Y NO HAY LÍMITE DE INTENTOS —la última parte del
  // test—: un evento pendiente no se convierte en pérdida silenciosa porque el broker tardó en volver.
  it("el reintento duplica desde un segundo y se corta en cinco minutos, sin límite de intentos", async () => {
    const { dispatcher, outbox, delivery, clock } = fixture();
    delivery.fails();
    await outbox.enqueueCreated(clasica());

    const delays: number[] = [];
    for (let intento = 0; intento < 11; intento += 1) {
      const antes = clock.now();
      await dispatcher.drain();
      const entry = await outbox.next(WHENEVER);
      delays.push((entry?.nextAttemptAt.getTime() ?? 0) - antes);
      clock.set(entry?.nextAttemptAt.getTime() ?? antes);
    }

    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ]);

    delivery.recovers();
    await dispatcher.drain();

    expect(delivery.published).toHaveLength(12);
    expect(await outbox.next(WHENEVER)).toBeUndefined();
  });

  // EL PLAZO DE CINCO SEGUNDOS, Y NO ES DECORACIÓN. `AmqpPublisher.publishTopic` NO RECHAZA solo con
  // el broker caído: se cuelga (`shared/amqp.ts`, `maxRetries: Infinity`). Sin este plazo el
  // dispatcher se queda esperando para siempre con el lease tomado, el outbox deja de drenar y nadie
  // ve un error.
  it("una publicación que cuelga se corta a los cinco segundos y agenda el reintento", async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher, outbox, delivery } = fixture();
      delivery.hangsOn();
      await outbox.enqueueCreated(clasica());

      const drenando = dispatcher.drain();
      await vi.advanceTimersByTimeAsync(4_999);
      // Todavía no: un plazo más corto cortaría una entrega que iba a confirmar.
      expect(await outbox.next(WHENEVER)).toMatchObject({ attempts: 0 });

      await vi.advanceTimersByTimeAsync(1);
      await drenando;

      expect(await outbox.next(WHENEVER)).toMatchObject({
        attempts: 1,
        nextAttemptAt: new Date(BASE_INSTANT + 1_000),
        lastError: expect.stringContaining("5000 ms"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // AL MENOS UNA VEZ, Y NUNCA FUERA DE ORDEN. Es la garantía que la spec declara: una caída entre el
  // confirm del broker y la marca de entregado republica, y el consumidor deduplica por `id`. Lo que
  // NO puede pasar es adelantar el segundo evento: un `updated` aplicado antes que el `updated`
  // anterior deja al consumidor con el modo viejo y sin error de nadie.
  it("una caída posterior al confirm reentrega la misma y nunca adelanta la siguiente", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    await outbox.enqueueCreated(clasica());
    await outbox.ensureUpdated(clasica({ uuid: "mode-2", name: "Rápida", version: 1 }));
    const muerte = vi
      .spyOn(outbox, "sent")
      .mockRejectedValue(new Error("el proceso murió antes de marcar"));

    await expect(dispatcher.drain()).rejects.toThrow("el proceso murió antes de marcar");
    await expect(dispatcher.drain()).rejects.toThrow("el proceso murió antes de marcar");

    expect(delivery.published.map((one) => one.body.id)).toEqual(["mode-1", "mode-1"]);

    muerte.mockRestore();
    await dispatcher.drain();

    expect(delivery.published.map((one) => one.body.id)).toEqual([
      "mode-1",
      "mode-1",
      "mode-1",
      "mode-2",
    ]);
  });
});

describe("OutboxDispatcher: la reconciliación", () => {
  // LA VENTANA MODO→OUTBOX, cerrada del lado del dispatcher. No hay replica set, así que escribir el
  // modo y escribir el outbox son dos operaciones: el proceso que muere entre las dos deja un modo con
  // revisión y sin evento, y nadie más que este tick lo va a notar.
  it("un modo sin evento recibe su updated en el mismo tick", async () => {
    const { dispatcher, delivery } = fixture({ modes: [clasica({ version: 2 })] });

    await dispatcher.drain();

    expect(delivery.published).toHaveLength(1);
    expect(delivery.published[0]).toMatchObject({
      routingKey: "game_mode.updated",
      body: { id: "mode-1" },
    });
  });

  it("un catálogo ya publicado no genera eventos nuevos", async () => {
    const modo = clasica({ version: 2 });
    const { dispatcher, outbox, delivery } = fixture({ modes: [modo] });
    await outbox.ensureUpdated(modo);

    await dispatcher.drain();
    await dispatcher.drain();

    expect(delivery.published).toHaveLength(1);
  });

  it("sin el lease tampoco reconcilia", async () => {
    const { dispatcher, outbox, delivery } = fixture({
      modes: [clasica({ version: 2 })],
      lease: deniedLease,
    });

    await dispatcher.drain();

    expect(delivery.published).toEqual([]);
    expect(await outbox.next(WHENEVER)).toBeUndefined();
  });
});

describe("OutboxDispatcher: el ciclo de vida", () => {
  it("start() programa un tick por segundo", async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher, outbox, delivery } = fixture();
      await outbox.enqueueCreated(clasica());

      dispatcher.start();
      expect(delivery.published).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(delivery.published).toHaveLength(1);
      await dispatcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // EL TIMER VA DESREFERENCIADO. Un intervalo referenciado mantiene vivo el event loop, así que el
  // proceso no termina de salir nunca —y la suite tampoco—: es la misma decisión que el plazo de
  // `shared/http/health.ts`.
  it("start() deja el temporizador desreferenciado", async () => {
    const { dispatcher } = fixture();
    const real = globalThis.setInterval;
    const creados: NodeJS.Timeout[] = [];
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      handler: () => void,
      ms?: number,
    ) => {
      const timer = real(handler, ms);
      creados.push(timer);
      return timer;
    }) as unknown as typeof setInterval);

    dispatcher.start();

    try {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toBe(1_000);
      expect(creados[0]?.hasRef()).toBe(false);
    } finally {
      // Después de restaurar, `mockRestore` también borra las llamadas grabadas: las aserciones van
      // antes. La primera versión de este test las tenía después y pasaba verde midiendo cero
      // llamadas contra un espía ya olvidado.
      spy.mockRestore();
    }
    await dispatcher.close();
  });

  it("start() dos veces no duplica los ticks", async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher, outbox, delivery } = fixture();
      await outbox.enqueueCreated(clasica());
      await outbox.ensureUpdated(clasica({ uuid: "mode-2", name: "Rápida", version: 1 }));

      dispatcher.start();
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(delivery.published).toHaveLength(1);
      await dispatcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() cancela los ticks programados", async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher, outbox, delivery } = fixture();
      dispatcher.start();
      await dispatcher.close();
      await outbox.enqueueCreated(clasica());

      await vi.advanceTimersByTimeAsync(5_000);

      expect(delivery.published).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // CLOSE() ESPERA EL TICK EN VUELO. Sin esta espera, el apagado le cierra la conexión AMQP por
  // debajo a una entrega que estaba confirmando: el mensaje puede haber salido y la marca de
  // entregado no llega nunca, o sea un duplicado garantizado en el arranque siguiente.
  it("close() espera la entrega en vuelo antes de resolver", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    let abrir!: () => void;
    delivery.hangsOn(
      new Promise<void>((resolve) => {
        abrir = resolve;
      }),
    );
    await outbox.enqueueCreated(clasica());
    const drenando = dispatcher.drain();
    await vi.waitFor(() => {
      expect(delivery.published).toHaveLength(1);
    });

    let cerrado = false;
    const cerrando = dispatcher.close().then(() => {
      cerrado = true;
    });
    // SE ESPERA UN TURNO COMPLETO DEL EVENT LOOP y no un `Promise.race` contra una promesa ya
    // resuelta: el race pasa verde contra un `close()` que no espera nada, porque `Promise.resolve`
    // gana la carrera de microtareas igual. Un `setTimeout` corre DESPUÉS de que se drenen todas las
    // microtareas, así que si `close()` resolviera solo, acá ya estaría en `true`. Medido: con la
    // espera de `inFlight` borrada, la versión con `race` seguía verde.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cerrado).toBe(false);

    abrir();
    await cerrando;
    expect(cerrado).toBe(true);
    await drenando;
    expect(await outbox.next(WHENEVER)).toBeUndefined();
  });

  // `wake()` ES EL ATAJO DE LA MUTACIÓN: sin él, el panel guarda un modo y el evento sale hasta un
  // segundo después. No devuelve promesa a propósito —el request administrativo no espera a Rabbit—,
  // así que lo que se mide es el efecto.
  it("wake() adelanta el tick sin esperar el temporizador", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    await outbox.enqueueCreated(clasica());

    dispatcher.wake();

    await vi.waitFor(() => {
      expect(delivery.published).toHaveLength(1);
    });
    await dispatcher.close();
  });

  // UN TICK QUE FALLA NO PUEDE TUMBAR EL PROCESO. `wake()` y el temporizador no tienen a quién
  // devolverle el error: sin el `catch`, un Mongo caído durante un tick es una promesa rechazada sin
  // manejador, y Node tumba el servidor con todas sus partidas en curso.
  it("un tick que falla se registra en vez de propagarse", async () => {
    const { dispatcher, outbox, log } = fixture();
    vi.spyOn(outbox, "next").mockRejectedValueOnce(new Error("mongo caído"));

    dispatcher.wake();

    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalled();
    });
    await dispatcher.close();
  });

  it("después de close() no se atienden más ticks", async () => {
    const { dispatcher, outbox, delivery } = fixture();
    await dispatcher.close();
    await outbox.enqueueCreated(clasica());

    dispatcher.wake();
    await dispatcher.drain();

    expect(delivery.published).toEqual([]);
  });
});
