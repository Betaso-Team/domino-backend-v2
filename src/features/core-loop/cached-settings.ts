import type { Logger } from "@/shared/logger";
import {
  type CoreLoopSettings,
  type CoreLoopSettingsSource,
  NEUTRAL_CORE_LOOP_SETTINGS,
} from "./settings";

// LAS PERILLAS, cacheadas: se consultan en cada tick del emparejador, así que sin cache y sin
// coalescer serían decenas de llamadas por segundo al backend principal. El molde es el de
// `CachedAntifraudFlag`, con el lado seguro DADO VUELTA: allá errar ENCENDIDO es seguro porque el veto
// es una preferencia de la que nada depende; acá errar con números INVENTADOS no lo es, así que una
// fuente que no contesta deja la ventana blanda APAGADA.

export class CachedCoreLoopSettings implements CoreLoopSettingsSource {
  private cache?: { value: CoreLoopSettings; expiresAt: number };
  private inFlight?: Promise<CoreLoopSettings>;

  constructor(
    private readonly source: CoreLoopSettingsSource,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  async settings(): Promise<CoreLoopSettings> {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.value;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.source
      .settings()
      .catch((err: unknown) => {
        this.log.error("no se pudieron leer los settings de core-loop: queda apagado", { err });
        return NEUTRAL_CORE_LOOP_SETTINGS;
      })
      .then((value) => {
        this.cache = { value, expiresAt: this.now() + this.ttlMs };
        return value;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }
}
