import { describe, expect, it } from "vitest";
import { MemoryKeyValueStore } from "./kv";

// El reloj se INYECTA, y por eso no hay un solo `await sleep()` acá abajo: el vencimiento se
// mide moviendo el reloj, no esperando. Un test que espera dos minutos para ver caducar una
// clave de dos minutos no es un test, es el plazo de producción corriendo en CI.
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("el almacén de clave-valor en memoria", () => {
  it("devuelve lo que guardó", async () => {
    const store = new MemoryKeyValueStore();

    await store.setex("k", "v", 60);

    expect(await store.get("k")).toBe("v");
  });

  it("no sabe nada de una clave que nadie escribió", async () => {
    expect(await new MemoryKeyValueStore().get("k")).toBeUndefined();
  });

  // EL PLAZO ES EN SEGUNDOS, que es la unidad de Redis y la de la implementación real.
  it("olvida la clave cuando se cumple el plazo", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    await store.setex("k", "v", 60);

    clock.advance(59_000);
    expect(await store.get("k")).toBe("v");
    clock.advance(1_000);
    expect(await store.get("k")).toBeUndefined();
  });

  // EL LATIDO, visto desde acá abajo: volver a escribir la misma clave corre el plazo entero.
  // Si `setex` conservara el vencimiento anterior, una sala viva perdería sus claves igual y el
  // latido sería decorativo.
  it("renueva el plazo al reescribir la clave", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    await store.setex("k", "v", 60);

    clock.advance(59_000);
    await store.setex("k", "v", 60);
    clock.advance(59_000);

    expect(await store.get("k")).toBe("v");
  });

  it("borra la clave que le piden borrar", async () => {
    const store = new MemoryKeyValueStore();
    await store.setex("k", "v", 60);

    store.del("k");

    expect(await store.get("k")).toBeUndefined();
  });
});

describe("el hash del almacén en memoria", () => {
  it("guarda, reemplaza y borra campos sin tocar los demás", async () => {
    const store = new MemoryKeyValueStore();
    await store.hset("censo", "room-1", "dos");
    await store.hset("censo", "room-2", "cuatro");
    await store.hset("censo", "room-1", "tres");

    await store.hdel("censo", "room-2");

    expect(await store.hgetall("censo")).toEqual({ "room-1": "tres" });
    expect(await store.get("censo")).toBeUndefined();
  });

  it("un hash vacío deja de existir", async () => {
    const store = new MemoryKeyValueStore();
    await store.hset("censo", "room-1", "dos");

    await store.hdel("censo", "room-1");

    expect(await store.hgetall("censo")).toEqual({});
  });
});
