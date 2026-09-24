import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it, vi } from "vitest";
import {
  type Maintenance,
  type MaintenanceBook,
  OPEN,
  PolledMaintenanceSignal,
} from "../maintenance";

// THE SIGNAL: the only thing that asks the database, and the source everyone else reads from. What is
// tested here is what makes it useful — notifying ONLY when it changed — and what makes it safe: that
// neither a downed book nor a broken listener leaves it mute forever.

const CERRADO: Maintenance = { isUnderMaintenance: true, message: "volvemos a las 18" };

// A book movable by hand: the state of the world a test changes between passes.
class FakeBook implements MaintenanceBook {
  value: Maintenance = OPEN;
  failing = false;
  reads = 0;

  async current(): Promise<Maintenance> {
    this.reads++;
    if (this.failing) throw new Error("la base no contesta");
    return this.value;
  }
}

const build = (book = new FakeBook()) => ({
  book,
  signal: new PolledMaintenanceSignal({ book, intervalMs: 3_000, log: new MemoryLogger() }),
});

describe("PolledMaintenanceSignal", () => {
  // Before the first pass nothing is known, and in doubt the game IS PLAYED: the opposite would close
  // access during every instance's startup.
  it("nace abierta, sin haber preguntado nada", () => {
    const { signal, book } = build();

    expect(signal.current()).toEqual(OPEN);
    expect(book.reads).toBe(0);
  });

  it("contesta de memoria lo último que vio", async () => {
    const { signal, book } = build();
    book.value = CERRADO;

    await signal.check();

    expect(signal.current()).toEqual(CERRADO);
  });

  it("avisa a sus oyentes cuando el interruptor se mueve", async () => {
    const { signal, book } = build();
    const heard: Maintenance[] = [];
    signal.onChange((m) => heard.push(m));

    book.value = CERRADO;
    await signal.check();

    expect(heard).toEqual([CERRADO]);
  });

  // CHANGES ONLY. Without this, every pass would broadcast the same thing to every lobby socket —
  // twenty messages a minute per player — to say nothing happened.
  it("no repite: una pasada sin novedades no avisa a nadie", async () => {
    const { signal, book } = build();
    const heard: Maintenance[] = [];
    signal.onChange((m) => heard.push(m));

    book.value = CERRADO;
    await signal.check();
    await signal.check();
    await signal.check();

    expect(heard).toHaveLength(1);
  });

  // Reopening is a change like any other, and announcing it matters as much as the close: without it
  // the front would stay blocked until someone reloaded.
  it("avisa también cuando el juego vuelve a abrir", async () => {
    const { signal, book } = build();
    const heard: Maintenance[] = [];
    signal.onChange((m) => heard.push(m));

    book.value = CERRADO;
    await signal.check();
    book.value = OPEN;
    await signal.check();

    expect(heard).toEqual([CERRADO, OPEN]);
  });

  // The MESSAGE is a change too: product can fix the text without flipping the switch, and the front
  // has to see the new text.
  it("cambiar solo el mensaje también se avisa", async () => {
    const { signal, book } = build();
    book.value = CERRADO;
    await signal.check();
    const heard: Maintenance[] = [];
    signal.onChange((m) => heard.push(m));

    book.value = { isUnderMaintenance: true, message: "volvemos a las 20" };
    await signal.check();

    expect(heard).toEqual([{ isUnderMaintenance: true, message: "volvemos a las 20" }]);
  });

  // What listens is a ROOM, born and dying many times over while the signal lives. Without releasing
  // the listener, every shut-down lobby would leave one attached to an object that lasts hours.
  it("se puede dejar de escuchar", async () => {
    const { signal, book } = build();
    const heard: Maintenance[] = [];
    const unwatch = signal.onChange((m) => heard.push(m));

    unwatch();
    book.value = CERRADO;
    await signal.check();

    expect(heard).toEqual([]);
  });

  // Each listener in its own try: one that blows up cannot leave the others unnotified — and the
  // others are the lobby next door and the emptying of the queues.
  it("un oyente que revienta no deja mudos a los otros", async () => {
    const { signal, book } = build();
    signal.onChange(() => {
      throw new Error("este oyente está roto");
    });
    const heard: Maintenance[] = [];
    signal.onChange((m) => heard.push(m));

    book.value = CERRADO;
    await signal.check();

    expect(heard).toEqual([CERRADO]);
  });

  // The book already fails open on its own; this covers the unexpected failure. What cannot happen is
  // the exception taking the interval with it and leaving the process blind forever.
  it("un fallo del libro no la deja muda: la pasada siguiente vuelve a ver", async () => {
    const { signal, book } = build();
    const heard: Maintenance[] = [];
    signal.onChange((m) => heard.push(m));

    book.failing = true;
    await signal.check();
    expect(heard).toEqual([]);

    book.failing = false;
    book.value = CERRADO;
    await signal.check();

    expect(heard).toEqual([CERRADO]);
  });

  // An instance coming up mid-maintenance has to know BEFORE it accepts anyone, not one interval
  // later.
  it("arrancar mira en el acto, sin esperar el intervalo", async () => {
    const { signal, book } = build();
    book.value = CERRADO;

    signal.start();
    await vi.waitFor(() => expect(signal.current()).toEqual(CERRADO));

    signal.stop();
  });

  it("parar corta el sondeo", async () => {
    const { signal, book } = build();
    signal.start();
    await vi.waitFor(() => expect(book.reads).toBeGreaterThan(0));

    signal.stop();
    const after = book.reads;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(book.reads).toBe(after);
  });
});
