import type { Logger } from "@/shared/logger";
import type { CoreLoopSettingsSource } from "./settings";
import type { SoftWindowBook } from "./soft-window-book";

/**
 * Lo que el emparejador necesita saber de UN candidato, resuelto una vez al encolarse: si prefiere
 * rivales flojos (`inSoftWindow`) y si ES el rival fuerte que los de esa ventana prefieren evitar
 * (`isShark`). La misma persona puede ser las dos cosas —uno fuerte recién salido de su propia
 * ventana de novato— y ninguna excluye a la otra.
 */
export interface SoftProfile {
  readonly inSoftWindow: boolean;
  readonly isShark: boolean;
}

/**
 * DE DÓNDE SALE EL WINRATE. Estructural y no el `PlayerLog` de `match`, a propósito: `match` paga con
 * core-loop, y si core-loop importara de `match` las dos features quedarían en un ciclo. El historial
 * de dominó lo satisface tal cual.
 */
export interface WinrateSource {
  statsOf(playerId: string): Promise<{ readonly gamesPlayed: number; readonly winRate: number }>;
}

type Stats = Awaited<ReturnType<WinrateSource["statsOf"]>>;
const NO_STATS: Stats = { gamesPlayed: 0, winRate: 0 };

/**
 * Combina las tres fuentes: las perillas (¿está prendida, y dónde está el techo de winrate?), el
 * libro de la ventana (¿ESTE jugador sigue adentro?) y el winrate propio (¿ÉL supera el techo?).
 * Apagada, contesta neutro antes de tocar las otras dos: sin filtro no hay por qué pagarlas.
 *
 * ⚠ FALLA ABIERTA, al revés que el resto de core-loop, y es la regla de v1
 * (`rooms/matchmaking/soft-profile.service.ts`): un perfil que no se pudo medir es un dato ausente,
 * no un rival prohibido. Bloquear el emparejamiento por un fallo sería peor que juntar a un novato
 * con alguien fuerte.
 */
export class SoftProfileResolver {
  private readonly statsCache = new Map<string, { value: Stats; expiresAt: number }>();
  private readonly statsInFlight = new Map<string, Promise<Stats>>();

  constructor(
    private readonly settingsSource: CoreLoopSettingsSource,
    private readonly softWindow: SoftWindowBook,
    private readonly stats: WinrateSource,
    // El recorrido del historial que hace `statsOf` no es gratis; una cache corta evita que el que
    // cancela y vuelve a encolarse lo pague dos veces.
    private readonly statsCacheTtlMs: number,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  async profileOf(playerId: string): Promise<SoftProfile> {
    const settings = await this.settingsSource.settings();
    if (!settings.enabled) return { inSoftWindow: false, isShark: false };

    const [remaining, stats] = await Promise.all([
      this.softWindow.remainingFor(playerId),
      this.cachedStatsOf(playerId),
    ]);

    return {
      inSoftWindow: remaining > 0,
      isShark:
        stats.gamesPlayed >= settings.minSampleForWinrateFilter &&
        stats.winRate >= settings.winrateCeiling,
    };
  }

  private cachedStatsOf(playerId: string): Promise<Stats> {
    const cached = this.statsCache.get(playerId);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);

    const inFlight = this.statsInFlight.get(playerId);
    if (inFlight) return inFlight;

    const promise = this.stats
      .statsOf(playerId)
      .catch((err: unknown) => {
        this.log.error("no se pudo leer el winrate: no filtra", { err, playerId });
        return NO_STATS;
      })
      .then((value) => {
        this.statsCache.set(playerId, { value, expiresAt: this.now() + this.statsCacheTtlMs });
        return value;
      })
      .finally(() => {
        this.statsInFlight.delete(playerId);
      });
    this.statsInFlight.set(playerId, promise);
    return promise;
  }
}
