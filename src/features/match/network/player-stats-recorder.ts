import type { Logger } from "@/logger";
import type { Lease } from "@/shared/mongo-lease";
import type {
  ClosedRound,
  HistoryEntry,
  HistoryPort,
  MatchClosing,
  MatchOpening,
  StoredMatchRecord,
} from "./history";
import { type PlayerStatsStore, type StatsBacklog, type StatsLine, linesOf } from "./player-stats";

const SWEEP_LEASE = "player-stats-sweep";
const SWEEP_LEASE_TTL_MS = 30_000;
const SWEEP_BATCH = 50;

// QUIEN APLICA LAS ESTADÍSTICAS, por dos caminos que se cubren entre sí. El inmediato (`afterClose`)
// corre justo después del cierre con el `MatchClosing` en memoria; el barrido relee de la base lo que
// quedó con `statsPending` —un proceso que murió entre el cierre y el aplicado, o un `apply` que
// falló— y lo reaplica. Aplicar es idempotente por (userId, endedAt), así que los dos pueden pisarse.
//
// NINGUNO LANZA: un rechazo que escape de un temporizador o de un `void` tumba el proceso, y una
// estadística que no se aplicó se reintenta en el siguiente turno. Una partida sólo se marca `settled`
// cuando TODAS sus líneas terminaron.
export class PlayerStatsRecorder {
  private readonly inFlight = new Set<Promise<void>>();
  private sweeping: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly sweepEveryMs: number;
  private readonly settleAfterMs: number;

  constructor(
    private readonly deps: {
      store: PlayerStatsStore;
      backlog: StatsBacklog;
      lease: Lease;
      logger: Logger;
      now: () => Date;
      sweepEveryMs?: number;
      settleAfterMs?: number;
    },
  ) {
    this.sweepEveryMs = deps.sweepEveryMs ?? 5_000;
    this.settleAfterMs = deps.settleAfterMs ?? 10_000;
  }

  // No espera: queda en vuelo y `drain()` lo espera.
  afterClose(matchId: string, closing: MatchClosing): void {
    // Una partida anulada no cuenta: nunca queda `statsPending`, así que no hay nada que dar por resuelto.
    if (closing.status !== "finished") return;
    const run = (async () => {
      try {
        await this.applyAll(matchId, linesOf(closing as unknown as StoredMatchRecord));
      } catch (error) {
        this.deps.logger.error("no se pudieron aplicar las estadísticas", { matchId, error });
      }
    })();
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  // Un turno del barrido. Nunca rechaza: el siguiente tick reintenta. Uno solo a la vez en el proceso:
  // el lease excluye PROCESOS y no llamadas, y un segundo `within` liberaría el lease del primero.
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const running = this.runSweep().finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = running;
    return running;
  }

  private async runSweep(): Promise<void> {
    try {
      await this.deps.lease.within(SWEEP_LEASE, SWEEP_LEASE_TTL_MS, async () => {
        const endedBefore = new Date(this.deps.now().getTime() - this.settleAfterMs);
        const documents = await this.deps.backlog.pending(endedBefore, SWEEP_BATCH);
        for (const document of documents) {
          const matchId = String(document.matchId);
          try {
            await this.applyAll(matchId, linesOf(document));
          } catch (error) {
            this.deps.logger.error("no se pudieron aplicar las estadísticas", { matchId, error });
          }
        }
      });
    } catch (error) {
      this.deps.logger.error("falló el barrido de estadísticas", { error });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.sweepEveryMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0 || this.sweeping) {
      await Promise.all([...this.inFlight, ...(this.sweeping ? [this.sweeping] : [])]);
    }
  }

  // En serie, y `settled` sólo si ninguna lanzó. Un "skipped" no se distingue de un reaplicado
  // idempotente, así que se avisa y se da por resuelto (el límite de orden que el diseño acepta).
  private async applyAll(matchId: string, lines: StatsLine[]): Promise<void> {
    for (const line of lines) {
      const result = await this.deps.store.apply(line);
      if (result === "skipped") {
        this.deps.logger.warn("estadística omitida: ya aplicada o más vieja que la última", {
          matchId,
          userId: line.userId,
        });
      }
    }
    await this.deps.backlog.settled(matchId);
  }
}

// El historial con el efecto de aplicar las estadísticas después de cada cierre. Delega los cuatro verbos.
export function recordingStats(history: HistoryPort, recorder: PlayerStatsRecorder): HistoryPort {
  return {
    open: (matchId: string, opening: MatchOpening) => history.open(matchId, opening),
    record: (entries: readonly HistoryEntry[]) => history.record(entries),
    round: (matchId: string, round: ClosedRound) => history.round(matchId, round),
    close(matchId: string, closing: MatchClosing) {
      history.close(matchId, closing);
      recorder.afterClose(matchId, closing);
    },
    async drain() {
      await history.drain();
      await recorder.drain();
    },
  };
}
