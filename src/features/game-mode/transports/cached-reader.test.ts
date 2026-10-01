import { describe, expect, it, vi } from "vitest";
import { CachedGameModeReader } from "./cached-reader";
import { MemoryGameModeRepository } from "./memory-repository";
import { clasica, mutableClock } from "./tests/repository-contract";

// Una fuente de verdad —el adaptador de memoria, no un doble— con un espía que CUENTA, que es el
// punto entero de ponerle un caché delante: el tick del emparejador pregunta cuatro veces por
// segundo, para siempre.
async function harness(ttlMs = 5_000) {
  const repository = new MemoryGameModeRepository(mutableClock());
  const mode = await repository.create(clasica());
  const clock = { now: 1_000 };
  const byUuid = vi.spyOn(repository, "byUuid");
  const reader = new CachedGameModeReader(repository, ttlMs, () => clock.now);
  return { repository, mode, clock, byUuid, reader };
}

describe("CachedGameModeReader", () => {
  it("la primera pregunta va a la fuente y las de adentro de la ventana no", async () => {
    const { mode, byUuid, reader } = await harness();

    for (let i = 0; i < 20; i++) await reader.byUuid(mode.uuid);

    expect(byUuid).toHaveBeenCalledTimes(1);
  });

  it("pasada la ventana vuelve a preguntar", async () => {
    const { mode, clock, byUuid, reader } = await harness();

    await reader.byUuid(mode.uuid);
    clock.now += 5_001;
    await reader.byUuid(mode.uuid);

    expect(byUuid).toHaveBeenCalledTimes(2);
  });

  it("cada modo tiene su propia ventana", async () => {
    const { mode, byUuid, reader } = await harness();

    await reader.byUuid(mode.uuid);
    await reader.byUuid("otro-modo");

    expect(byUuid).toHaveBeenCalledTimes(2);
  });

  // Cuatro jugadores que entran a la cola en el mismo instante dispararían cuatro lecturas del mismo
  // modo. Se lanzan EN EL MISMO TURNO: esperar a que la primera termine deja verde a un caché sin
  // la lectura en vuelo.
  it("varias preguntas a la vez esperan la misma respuesta", async () => {
    const { mode, byUuid, reader } = await harness();

    await Promise.all([reader.byUuid(mode.uuid), reader.byUuid(mode.uuid)]);

    expect(byUuid).toHaveBeenCalledTimes(1);
  });

  // El caso que más conviene ahorrar: un id viejo que el cliente tenía guardado se pregunta en cada
  // tick de una cola que nunca se va a formar.
  it("la AUSENCIA también se recuerda", async () => {
    const { byUuid, reader } = await harness();

    expect(await reader.byUuid("no-existe")).toBeUndefined();
    expect(await reader.byUuid("no-existe")).toBeUndefined();
    expect(byUuid).toHaveBeenCalledTimes(1);
  });

  // «La base no contestó» no es un estado del modo. Recordarlo cerraría la cola durante la ventana
  // entera por un hipo — y peor: el emparejador VACÍA el pozo cuya especificación lanza.
  it("el ERROR no se recuerda: el siguiente vuelve a intentar", async () => {
    const { mode, byUuid, reader } = await harness();
    byUuid.mockRejectedValueOnce(new Error("la base no contesta"));

    await expect(reader.byUuid(mode.uuid)).rejects.toThrow();
    expect((await reader.byUuid(mode.uuid))?.uuid).toBe(mode.uuid);
    expect(byUuid).toHaveBeenCalledTimes(2);
  });

  // `activeByUuid` es la lectura con la que NACE una mesa y congela su economía: pasa derecha. El
  // caché es para quien SONDEA, no para quien decide qué se cobra.
  it("las otras tres lecturas pasan derecho, sin recordarse", async () => {
    const { repository, mode, reader } = await harness();
    const active = vi.spyOn(repository, "activeByUuid");
    const list = vi.spyOn(repository, "active");
    const all = vi.spyOn(repository, "all");

    for (let i = 0; i < 2; i++) {
      await reader.activeByUuid(mode.uuid);
      await reader.active();
      await reader.all();
    }

    expect(active).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(all).toHaveBeenCalledTimes(2);
  });
});
