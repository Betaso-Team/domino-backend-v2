import type { Logger } from "@/shared/logger";
import type { BetLevel } from "../core/config";

// LOS NIVELES DE AUMENTO QUE UNA MESA OFRECE, y de dónde salen: del backend principal, que es
// quien los configura. Este repo no los inventa ni los guarda.
//
// ⚠ LA LISTA VACÍA ES EL REPOSO Y NO UN ERROR. Sin niveles, `canProposeBet` rechaza con
// `BETTING_DISABLED` y la mesa simplemente no ofrece aumentar. Es lo que hace v1 y es lo que
// hace que una instancia sin `BACKEND_URL` sea segura en vez de estar rota.

/**
 * FALLA CERRADO, y acá el criterio se aparta del de otros flags del repo.
 *
 * El antifraude falla ENCENDIDO —dejar de vetar es peor que vetar de más— pero esto falla hacia
 * el NO por una razón distinta: el `extra` de un nivel determina PUNTOS DE RANKING reales, y
 * ofrecer un nivel con un valor inventado le entrega al jugador un puntaje que nadie configuró.
 * Es el mismo argumento de v1 (`bet-increase.service.ts`), escrito ahí en una nota aparte
 * justamente porque contradice al otro.
 */
export interface BetLevelBook {
  /** Los niveles de ESTE modo. Vacío = esta mesa no ofrece aumentar. */
  levelsOf(gameModeId: string): Promise<readonly BetLevel[]>;
}

/** El reposo: ninguna mesa ofrece aumentar. Es lo que corre sin `BACKEND_URL`. */
export const NO_BET_LEVELS: BetLevelBook = { levelsOf: async () => [] };

/**
 * CACHE POR MODO, con coalescing. Los dos hacen falta y por motivos distintos:
 *
 *   · la cache, porque esto se consulta al CREAR CADA MESA y los niveles de un modo cambian
 *     cuando el panel los toca, no entre dos partidas;
 *   · el coalescing, porque veinte mesas del mismo modo naciendo a la vez —que es exactamente
 *     lo que hace un pico de matchmaking— producirían veinte llamadas idénticas en vuelo.
 *
 * Es el gemelo de `CachedAntifraudFlag`, con UNA diferencia: la clave. Aquél cachea un flag
 * global y éste una lista POR MODO, así que un `Map` y no un campo — con un solo valor, dos
 * modos distintos se pisarían y una mesa cara ofrecería los niveles de una barata.
 */
export class CachedBetLevelBook implements BetLevelBook {
  private readonly cache = new Map<string, { levels: readonly BetLevel[]; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<readonly BetLevel[]>>();

  constructor(
    private readonly source: BetLevelBook,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  async levelsOf(gameModeId: string): Promise<readonly BetLevel[]> {
    const cached = this.cache.get(gameModeId);
    if (cached && cached.expiresAt > this.now()) return cached.levels;
    const pending = this.inFlight.get(gameModeId);
    if (pending) return pending;

    const request = this.source
      .levelsOf(gameModeId)
      .catch((err: unknown) => {
        // FALLA CERRADO: la mesa no ofrece aumentar. Y se DICE, porque el síntoma del otro lado
        // —un botón que no aparece— no se distingue de una mesa que nunca lo tuvo.
        this.log.error("no se pudieron leer los niveles de aumento: la mesa no los ofrece", {
          err,
          gameModeId,
        });
        return [] as readonly BetLevel[];
      })
      .then((levels) => {
        this.cache.set(gameModeId, { levels, expiresAt: this.now() + this.ttlMs });
        return levels;
      })
      .finally(() => {
        this.inFlight.delete(gameModeId);
      });

    this.inFlight.set(gameModeId, request);
    return request;
  }
}
