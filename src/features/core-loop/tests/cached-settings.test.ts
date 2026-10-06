import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { CachedCoreLoopSettings } from "../cached-settings";
import type { CoreLoopSettings } from "../settings";

const ON: CoreLoopSettings = {
  enabled: true,
  rake0Matches: 5,
  softWindowMatches: 10,
  winrateCeiling: 0.6,
  minSampleForWinrateFilter: 10,
  softTimeoutSeconds: 35,
};

const counting = (clock: { now: number }) => {
  let calls = 0;
  const settings = new CachedCoreLoopSettings(
    {
      settings: async () => {
        calls++;
        return ON;
      },
    },
    5_000,
    () => clock.now,
    new MemoryLogger(),
  );
  return { settings, calls: () => calls };
};

describe("CachedCoreLoopSettings", () => {
  it("cachea: N lecturas a la vez no son N consultas", async () => {
    const { settings, calls } = counting({ now: 1000 });

    await Promise.all([settings.settings(), settings.settings()]);
    await settings.settings();

    expect(calls()).toBe(1);
  });

  it("la cache es corta: un apagado de emergencia tiene que hacer efecto casi en el acto", async () => {
    const clock = { now: 1000 };
    const { settings, calls } = counting(clock);

    await settings.settings();
    clock.now += 5_001;
    await settings.settings();

    expect(calls()).toBe(2);
  });

  // LA ASIMETRÍA CON EL ANTIFRAUDE: allá fallar ENCENDIDO es seguro —una preferencia de la que nada
  // depende—; acá fallar con números INVENTADOS no lo es: un `winrateCeiling` de 0 filtraría con un
  // dato que no significa nada. Sin backend, la ventana blanda queda APAGADA.
  it("si el backend no contesta, el filtro blando queda APAGADO", async () => {
    const settings = new CachedCoreLoopSettings(
      {
        settings: async () => {
          throw new Error("backend caído");
        },
      },
      5_000,
      () => 1000,
      new MemoryLogger(),
    );

    expect(await settings.settings()).toMatchObject({ enabled: false });
  });
});
