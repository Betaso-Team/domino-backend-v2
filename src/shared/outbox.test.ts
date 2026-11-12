import type { Logger } from "@/logger";
import { describe, expect, it, vi } from "vitest";
import type { AmqpDelivery, TopicPublishOptions } from "./amqp";
import { MemoryLease } from "./mongo-lease";
import { MemoryOutboxStore, TopicOutboxDispatcher } from "./outbox";

// EL DESPACHADOR DEL OUTBOX: no adelantarse, marcar después del confirm, la ventana del broker caído
// con su backoff sin límite de intentos, `wake()` que la ignora, y el lease que sólo se toma si hay
// algo pendiente. El camino entero del resultado lo mide `orchestrator-money.e2e.test.ts`.

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

function clock() {
  let now = Date.UTC(2026, 9, 5);
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function recording() {
  const published: Array<{ routingKey: string; body: unknown; options?: TopicPublishOptions }> = [];
  let failing = false;
  let calls = 0;
  const port: AmqpDelivery = {
    async publishTopic(_exchange, routingKey, body, options) {
      calls += 1;
      if (failing) throw new Error("devuelto por el broker");
      published.push({ routingKey, body, options });
    },
    async publishPattern() {
      throw new Error("el outbox publica al exchange, no a una cola");
    },
  };
  return {
    published,
    port,
    // Intentos, confirmados o no.
    attempts: () => calls,
    fails() {
      failing = true;
    },
    recovers() {
      failing = false;
    },
  };
}

function fixture(perTick?: number, stuckAfterMs?: number) {
  const time = clock();
  const log = fakeLogger();
  const store = new MemoryOutboxStore<string, { n: number }>(time);
  const delivery = recording();
  const lease = new MemoryLease();
  const within = vi.spyOn(lease, "within");
  const dispatcher = new TopicOutboxDispatcher({
    exchange: "tablea_gaming",
    leaseName: "match-result-publisher",
    queue: store,
    delivery: delivery.port,
    lease,
    clock: time,
    log,
    label: "resultado de partida",
    publishOptions: (entry) => ({ mandatory: true, messageId: entry.dedupeKey }),
    ...(perTick !== undefined && { perTick }),
    ...(stuckAfterMs !== undefined && { stuckAfterMs }),
  });
  return { time, store, delivery, dispatcher, log, within };
}

// Un turno del event loop: `wake()` no devuelve promesa.
const settle = () => new Promise((resume) => setTimeout(resume, 0));

describe("TopicOutboxDispatcher", () => {
  it("le pasa al publicador las opciones que el uso deriva de cada entrada", async () => {
    const { store, delivery, dispatcher } = fixture();
    await store.enqueue("m-1:finished", "domino.match.finished", { n: 1 });

    await dispatcher.drain();

    expect(delivery.published).toEqual([
      {
        routingKey: "domino.match.finished",
        body: { n: 1 },
        options: { mandatory: true, messageId: "m-1:finished" },
      },
    ]);
  });

  it("un tick publica hasta `perTick` entradas, en orden", async () => {
    const { store, delivery, dispatcher } = fixture(2);
    for (const n of [1, 2, 3]) await store.enqueue(`m-${n}`, "domino.match.finished", { n });

    dispatcher.wake();
    await settle();
    await dispatcher.close();

    expect(delivery.published.map((one) => one.body)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("por default, una por tick, que es lo que el catálogo necesita", async () => {
    const { store, delivery, dispatcher } = fixture();
    for (const n of [1, 2]) await store.enqueue(`m-${n}`, "domino.match.finished", { n });

    dispatcher.wake();
    await settle();
    await dispatcher.close();

    expect(delivery.published).toHaveLength(1);
  });

  it("un rechazo corta el tick y la entrada que falló pasa detrás de las no intentadas", async () => {
    const { store, delivery, dispatcher } = fixture(5);
    for (const n of [1, 2]) await store.enqueue(`m-${n}`, "domino.match.finished", { n });
    delivery.fails();

    await dispatcher.drain();

    expect(delivery.attempts()).toBe(1);
    expect(await store.statuses(["m-1", "m-2"])).toEqual(
      new Map([
        ["m-1", "PENDING"],
        ["m-2", "PENDING"],
      ]),
    );
    expect(await store.next()).toMatchObject({ dedupeKey: "m-2", attempts: 0 });
  });

  it("con la cola vacía, el tick no toma el lease", async () => {
    const { dispatcher, within } = fixture(20);

    await dispatcher.drain();
    dispatcher.wake();
    await settle();
    await dispatcher.close();

    expect(within).not.toHaveBeenCalled();
  });
});

// LA ESPERA ES DEL BROKER Y NO DE CADA ENTRADA: lo que antes era un `nextAttemptAt` de hasta cinco
// minutos que bloqueaba a toda la cola detrás de la primera entrada.
describe("TopicOutboxDispatcher: la ventana del broker caído", () => {
  it("dentro de la ventana el tick programado no publica ni toca la cola", async () => {
    const { time, store, delivery, dispatcher, within } = fixture(20);
    await store.enqueue("m-1", "domino.match.finished", { n: 1 });
    delivery.fails();
    await dispatcher.drain();
    expect(delivery.attempts()).toBe(1);
    const hasPending = vi.spyOn(store, "hasPending");
    within.mockClear();

    delivery.recovers();
    time.advance(999);
    await dispatcher.drain();

    expect(delivery.attempts()).toBe(1);
    expect(hasPending).not.toHaveBeenCalled();
    expect(within).not.toHaveBeenCalled();

    time.advance(1);
    await dispatcher.drain();
    expect(delivery.published.map((one) => one.body)).toEqual([{ n: 1 }]);
  });

  it("el backoff duplica con cada fallo seguido y se corta en 30 s", async () => {
    const { time, store, delivery, dispatcher } = fixture(20);
    await store.enqueue("m-1", "domino.match.finished", { n: 1 });
    delivery.fails();

    const windows: number[] = [];
    for (let failure = 0; failure < 8; failure += 1) {
      await dispatcher.drain();
      let waited = 0;
      while (delivery.attempts() === failure + 1) {
        time.advance(1_000);
        waited += 1_000;
        await dispatcher.drain();
      }
      windows.push(waited);
    }

    expect(windows).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect((await store.next())?.attempts).toBe(9);
  });

  it("`wake()` sondea dentro de la ventana y publica todo lo pendiente; la que falló, al final", async () => {
    const { store, delivery, dispatcher } = fixture(20);
    for (const n of [1, 2]) await store.enqueue(`m-${n}`, "domino.match.finished", { n });
    delivery.fails();
    await dispatcher.drain();

    delivery.recovers();
    await store.enqueue("m-3", "domino.match.finished", { n: 3 });
    dispatcher.wake();
    await settle();
    await dispatcher.close();

    expect(delivery.published.map((one) => one.body)).toEqual([{ n: 2 }, { n: 3 }, { n: 1 }]);
    expect(await store.hasPending()).toBe(false);
  });

  it("un `wake()` con un tick en vuelo vuelve a sondear al terminar", async () => {
    const { store, delivery, dispatcher } = fixture(20);
    await store.enqueue("m-1", "domino.match.finished", { n: 1 });
    delivery.fails();
    await dispatcher.drain();
    delivery.recovers();

    // El tick programado sale por la ventana; el `wake()` llega mientras está en vuelo.
    const scheduled = dispatcher.drain();
    dispatcher.wake();
    await scheduled;
    await settle();
    await dispatcher.close();

    expect(delivery.published.map((one) => one.body)).toEqual([{ n: 1 }]);
  });

  it("una publicación confirmada cierra la ventana y vuelve el backoff a un segundo", async () => {
    const { time, store, delivery, dispatcher } = fixture(20);
    await store.enqueue("m-1", "domino.match.finished", { n: 1 });
    delivery.fails();
    for (let failure = 0; failure < 4; failure += 1) {
      await dispatcher.drain();
      time.advance(30_000);
    }
    expect(delivery.attempts()).toBe(4);

    delivery.recovers();
    await dispatcher.drain();
    expect(delivery.published).toHaveLength(1);

    // Otro fallo: la ventana vuelve a ser de un segundo, no de dieciséis.
    await store.enqueue("m-2", "domino.match.finished", { n: 2 });
    delivery.fails();
    await dispatcher.drain();
    delivery.recovers();
    time.advance(1_000);
    await dispatcher.drain();
    expect(delivery.published.map((one) => one.body)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

// UN RESULTADO TRABADO TIENE QUE VERSE antes de que un jugador reclame su premio. Cada fallo deja un
// `warn` —un broker que se reinicia es normal—; pasado el umbral, cada fallo es un `error`, que es lo
// que una alerta mira.
describe("TopicOutboxDispatcher: lo que no sale", () => {
  it("avisa con un error cuando la entrada lleva más que el umbral sin salir", async () => {
    const { time, store, delivery, dispatcher, log } = fixture(1, 600_000);
    await store.enqueue("m-1", "domino.match.finished", { n: 1 });
    delivery.fails();

    await dispatcher.drain();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();

    time.advance(600_000);
    await dispatcher.drain();
    expect(log.error).toHaveBeenCalledWith(
      "el resultado de partida lleva demasiado sin salir",
      expect.objectContaining({ id: expect.any(String), pendingMs: 600_000 }),
    );
  });
});

// UNA ENTRADA ENVENENADA no traba a las demás y, si falla con el broker sano, se estaciona.
describe("TopicOutboxDispatcher: la entrada que falla sola", () => {
  function poisoned(maxStrikes = 3) {
    const time = clock();
    const log = fakeLogger();
    const store = new MemoryOutboxStore<string, { n: number }>(time);
    const published: number[] = [];
    const delivery: AmqpDelivery = {
      async publishTopic(_exchange, _routingKey, body) {
        const { n } = body as { n: number };
        if (n === 0) throw new Error("devuelto: sin cola");
        published.push(n);
      },
      async publishPattern() {
        throw new Error("no");
      },
    };
    const dispatcher = new TopicOutboxDispatcher({
      exchange: "tablea_gaming",
      leaseName: "l",
      queue: store,
      delivery,
      lease: new MemoryLease(),
      clock: time,
      log,
      label: "resultado de partida",
      perTick: 10,
      maxStrikes,
    });
    return { time, log, store, published, dispatcher };
  }

  it("las de atrás salen aunque la primera falle siempre", async () => {
    const { time, store, published, dispatcher } = poisoned(100);
    await store.enqueue("veneno", "r", { n: 0 });
    for (const n of [1, 2, 3]) await store.enqueue(`m-${n}`, "r", { n });

    for (let i = 0; i < 4; i += 1) {
      await dispatcher.drain();
      time.advance(31_000);
    }

    expect(published).toEqual([1, 2, 3]);
  });

  it("a los `maxStrikes` fallos con el broker sano queda PARKED, con el cuerpo en el log", async () => {
    const { time, log, store, dispatcher } = poisoned(3);
    await store.enqueue("veneno", "r", { n: 0 });
    // Cada ronda: una sana confirma (el broker está bien) y la envenenada falla con strike.
    for (let round = 1; round <= 3; round += 1) {
      await store.enqueue(`sana-${round}`, "r", { n: round });
      await dispatcher.drain();
      time.advance(31_000);
      await dispatcher.drain();
      time.advance(31_000);
    }

    expect(await store.statuses(["veneno"])).toEqual(new Map([["veneno", "PARKED"]]));
    expect(await store.parkedCount()).toBe(1);
    expect(await store.hasPending()).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "resultado de partida estacionado: falló 3 veces con el broker sano",
      expect.objectContaining({ dedupeKey: "veneno", payload: { n: 0 } }),
    );
  });

  it("una caída del broker no estaciona: sólo el primer fallo de la racha es strike", async () => {
    const time = clock();
    const store = new MemoryOutboxStore<string, { n: number }>(time);
    const delivery = recording();
    const dispatcher = new TopicOutboxDispatcher({
      exchange: "tablea_gaming",
      leaseName: "l",
      queue: store,
      delivery: delivery.port,
      lease: new MemoryLease(),
      clock: time,
      log: fakeLogger(),
      label: "resultado de partida",
      maxStrikes: 2,
    });
    await store.enqueue("m-1", "r", { n: 1 });
    delivery.fails();
    for (let i = 0; i < 20; i += 1) {
      await dispatcher.drain();
      time.advance(31_000);
    }
    delivery.recovers();
    await dispatcher.drain();

    expect(delivery.published).toHaveLength(1);
    expect(await store.parkedCount()).toBe(0);
  });
});

describe("MemoryOutboxStore", () => {
  it("ofrece el de menos intentos y, entre iguales, el más viejo", async () => {
    const store = new MemoryOutboxStore<string, number>(clock());
    expect(await store.hasPending()).toBe(false);
    await store.enqueue("a", "r", 1);
    await store.enqueue("b", "r", 2);

    const first = await store.next();
    expect(first?.dedupeKey).toBe("a");
    await store.retry(first?.id ?? "", "caído");
    expect(await store.next()).toMatchObject({ dedupeKey: "b", attempts: 0 });

    const second = await store.next();
    await store.sent(second?.id ?? "", new Date());
    expect(await store.next()).toMatchObject({ dedupeKey: "a", attempts: 1, lastError: "caído" });
    expect(await store.hasPending()).toBe(true);
  });

  it("dos entradas con la misma clave exclusiva no conviven", async () => {
    const store = new MemoryOutboxStore<string, number>(clock());
    expect(await store.enqueue("m:finished", "r", 1, { exclusiveKey: "m" })).toBe(true);
    expect(await store.enqueue("m:aborted", "r", 2, { exclusiveKey: "m" })).toBe(false);
    expect([...(await store.present(["m:finished", "m:aborted"]))]).toEqual(["m:finished"]);
  });

  it("encolar dos veces la misma clave deja una sola entrada, y lo dice", async () => {
    const store = new MemoryOutboxStore<string, number>(clock());

    expect(await store.enqueue("k", "r", 1)).toBe(true);
    expect(await store.enqueue("k", "r", 2)).toBe(false);
    expect([...(await store.present(["k", "otra"]))]).toEqual(["k"]);
  });
});
