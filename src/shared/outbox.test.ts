import type { Logger } from "@/logger";
import { describe, expect, it, vi } from "vitest";
import type { AmqpDelivery, TopicPublishOptions } from "./amqp";
import { MemoryLease } from "./mongo-lease";
import { MemoryOutboxStore, TopicOutboxDispatcher } from "./outbox";

// LO QUE EL DESPACHADOR COMPARTIDO AGREGA SOBRE EL DEL CATÁLOGO. Las reglas de siempre —no
// adelantarse, marcar después del confirm, backoff sin límite, el lease— las mide
// `features/game-mode/outbox.test.ts` a través de la capa del catálogo, que ahora es una envoltura
// de éste; acá van las dos perillas que el segundo usuario necesita y el primero no usa.

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
  const port: AmqpDelivery = {
    async publishTopic(_exchange, routingKey, body, options) {
      published.push({ routingKey, body, options });
      if (failing) throw new Error("devuelto por el broker");
    },
    async publishPattern() {
      throw new Error("el outbox publica al exchange, no a una cola");
    },
  };
  return {
    published,
    port,
    fails() {
      failing = true;
    },
  };
}

function fixture(perTick?: number, stuckAfterMs?: number) {
  const time = clock();
  const log = fakeLogger();
  const store = new MemoryOutboxStore<string, { n: number }>(time);
  const delivery = recording();
  const dispatcher = new TopicOutboxDispatcher({
    exchange: "betaso_games",
    leaseName: "match-result-publisher",
    queue: store,
    delivery: delivery.port,
    lease: new MemoryLease(),
    clock: time,
    log,
    label: "resultado de partida",
    publishOptions: (entry) => ({ mandatory: true, messageId: entry.dedupeKey }),
    ...(perTick !== undefined && { perTick }),
    ...(stuckAfterMs !== undefined && { stuckAfterMs }),
  });
  return { time, store, delivery, dispatcher, log };
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

  it("un rechazo corta el tick y deja la entrada para el reintento, sin adelantar la siguiente", async () => {
    const { time, store, delivery, dispatcher } = fixture(5);
    for (const n of [1, 2]) await store.enqueue(`m-${n}`, "domino.match.finished", { n });
    delivery.fails();

    await dispatcher.drain();

    expect(delivery.published.map((one) => one.body)).toEqual([{ n: 1 }]);
    expect(await store.next(new Date(time.now()))).toBeUndefined();
    time.advance(1_000);
    expect((await store.next(new Date(time.now())))?.dedupeKey).toBe("m-1");
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

describe("MemoryOutboxStore", () => {
  it("encolar dos veces la misma clave deja una sola entrada, y lo dice", async () => {
    const store = new MemoryOutboxStore<string, number>(clock());

    expect(await store.enqueue("k", "r", 1)).toBe(true);
    expect(await store.enqueue("k", "r", 2)).toBe(false);
    expect([...(await store.present(["k", "otra"]))]).toEqual(["k"]);
  });
});
