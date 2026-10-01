import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SettingsOverrides } from "../sections";
import { PolledSettingsSignal } from "../signal";
import type { SettingsBook } from "../store";
import { MemorySettings } from "../transports/memory-settings";

// EL VALOR CALIENTE: lo que cada proceso contesta mientras a la base se le pregunta cada tanto. Lo que
// importa acá no es la mezcla sino qué pasa cuando lo leído no sirve — ése es el camino que decide si
// un hipo de la base puede cambiar cómo se juega. Portado de truco (`3cab0f8`).

interface Demo {
  readonly aMs: number;
  readonly bMs: number;
}

const DEFAULTS: Demo = { aMs: 1000, bMs: 2000 };

const schema = z
  .strictObject({ aMs: z.number().int().min(1), bMs: z.number().int().min(1) })
  .partial();

// Una base que se puede cortar, que es el caso que separa «no hay overrides» de «no se pudo saber».
class FlakyBook implements SettingsBook {
  fail = false;
  constructor(private readonly source: MemorySettings) {}
  current(): Promise<SettingsOverrides> {
    return this.fail ? Promise.reject(new Error("la base no contesta")) : this.source.current();
  }
}

const signalOf = (book: SettingsBook, log = new MemoryLogger()) =>
  new PolledSettingsSignal({
    book,
    sections: [{ name: "demo", schema, editable: ["aMs", "bMs"], defaults: () => DEFAULTS }],
    intervalMs: 60_000,
    log,
  });

describe("La configuración caliente", () => {
  it("antes de la primera pasada contesta los defaults, sin preguntarle a nadie", () => {
    const signal = signalOf(new MemorySettings());

    expect(signal.effective<Demo>("demo")).toEqual(DEFAULTS);
    expect(signal.overrides("demo")).toEqual({});
  });

  it("después de una pasada, el override pisa SOLO su campo", async () => {
    const store = new MemorySettings();
    await store.save("demo", { aMs: 50 });
    const signal = signalOf(store);

    await signal.check();

    expect(signal.effective<Demo>("demo")).toEqual({ aMs: 50, bMs: 2000 });
    expect(signal.overrides("demo")).toEqual({ aMs: 50 });
  });

  // Un hipo de la base que devolviera a todo el clúster a los defaults a mitad de sesión sería una
  // falla peor que estar unos segundos viejo.
  it("si la base deja de contestar, queda el último valor bueno y no los defaults", async () => {
    const store = new MemorySettings();
    await store.save("demo", { aMs: 50 });
    const book = new FlakyBook(store);
    const log = new MemoryLogger();
    const signal = signalOf(book, log);
    await signal.check();

    book.fail = true;
    await signal.check();

    expect(signal.effective<Demo>("demo").aMs).toBe(50);
    expect(log.lines.some((line) => line.level === "warn")).toBe(true);
  });

  // Una edición a mano, o un campo de otra época: en los dos casos el resto de la sección no es
  // confiable, y envenenaría a toda mesa que nazca después.
  it("una sección guardada que no pasa su esquema se descarta ENTERA", async () => {
    const store = new MemorySettings();
    await store.save("demo", { aMs: 50, bMs: 0 });
    const log = new MemoryLogger();
    const signal = signalOf(store, log);

    await signal.check();

    expect(signal.effective<Demo>("demo")).toEqual(DEFAULTS);
    expect(log.lines.some((line) => line.level === "error")).toBe(true);
  });

  // Se compone por la LISTA DE LOS DEFAULTS y no esparciendo los dos: un campo que el tipo ya no
  // tiene deja de viajar en vez de sobrevivir en la base.
  it("un campo que el tipo ya no tiene no viaja, aunque esté guardado", async () => {
    const store = new MemorySettings();
    await store.save("demo", { aMs: 50, deUnaEpocaAnterior: 7 });
    const signal = new PolledSettingsSignal({
      book: store,
      sections: [
        { name: "demo", schema: z.looseObject({}), editable: [], defaults: () => DEFAULTS },
      ],
      intervalMs: 60_000,
      log: new MemoryLogger(),
    });

    await signal.check();

    expect(signal.effective<Demo>("demo")).toEqual({ aMs: 50, bMs: 2000 });
    expect(signal.effective<Demo>("demo")).not.toHaveProperty("deUnaEpocaAnterior");
  });

  // Los defaults se leen AL PREGUNTAR y no al construir: la suite re-registra la base a mitad de
  // corrida, y ése tiene que ganarle a un valor que la señal se hubiera guardado de antes.
  it("los defaults se leen al preguntar, no al construir", () => {
    let base: Demo = DEFAULTS;
    const signal = new PolledSettingsSignal({
      book: new MemorySettings(),
      sections: [{ name: "demo", schema, editable: [], defaults: () => base }],
      intervalMs: 60_000,
      log: new MemoryLogger(),
    });

    base = { aMs: 7, bMs: 8 };

    expect(signal.effective<Demo>("demo")).toEqual({ aMs: 7, bMs: 8 });
  });

  it("una sección que nadie cableó no se puede preguntar", () => {
    expect(() => signalOf(new MemorySettings()).effective("la-que-no-existe")).toThrow();
  });
});

describe("MemorySettings", () => {
  it("un parche se suma a lo que la sección ya tenía", async () => {
    const store = new MemorySettings();

    await store.save("demo", { aMs: 1 });
    await store.save("demo", { bMs: 2 });

    expect(await store.current()).toEqual({ demo: { aMs: 1, bMs: 2 } });
  });

  it("borrar la sección la devuelve entera a los defaults", async () => {
    const store = new MemorySettings();
    await store.save("demo", { aMs: 1 });

    expect(await store.clear("demo")).toEqual({});
  });
});
