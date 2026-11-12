import type { Logger } from "@/shared/logger";
import type { Lease } from "@/shared/mongo-lease";
import type { MatchMode } from "../core/config";
import {
  MATCH_ABORTED_KEY,
  type MatchAbortedPayload,
  type MatchResultOutbox,
} from "./match-results";

// LAS PARTIDAS QUE MURIERON CON SU PROCESO. `MATCH_ABORTED` sale de `onDispose` de la sala, y un
// proceso que muere de golpe —OOM, `kill -9`, el `kill_timeout` de pm2— no corre `onDispose`: la
// partida queda abierta en `match_history` (`status: "started"`) y nadie publica su desenlace. El
// orquestador tiene su propia red (`GET .../existence`, `live: false && outcome: "none"` pasada la
// duración máxima), pero tarda horas; ésta la cierra en minutos, con el mismo mensaje de siempre:
// `domino.match.aborted`, motivo `INTERRUPTED`, clave `<matchId>:aborted`.
//
// UNA PARTIDA SE RECUPERA SÓLO SI LAS CINCO CONDICIONES SE CUMPLEN, cada una contra un caso real:
//
//   1. Su registro está ABIERTO (`started`) y NO SE ESCRIBE hace más de `graceMs` (10 min). Una
//      partida viva escribe en cada jugada y en cada vencimiento (el más largo, turno + reserva, es de
//      minutos): el plazo es la segunda línea contra una mesa viva que el registro de Redis perdió.
//   2. Su mesa NO ESTÁ VIVA en ningún proceso (`isLive`, el registro del clúster con su latido).
//   3. Ningún proceso vivo tiene su resultado EN MEMORIA sin poder encolarlo (`resultHeld`, la marca
//      que `MatchResultRecorder` pone con Mongo caído). Sin esto, un proceso vivo que reintenta un
//      `finished` competiría con este `aborted`.
//   4. El outbox NO TIENE NINGÚN DESENLACE de la partida (`present`).
//   5. EL INSERT GANA: el outbox excluye un desenlace del otro por `exclusiveKey` (único parcial de
//      Mongo). Si entre 4 y 5 alguien encoló `finished`, este insert falla y no se publica nada más.
//
// La 5 es la que GARANTIZA que una partida nunca publique `finished` y `aborted`; las 1 a 4 son las que
// eligen bien CUÁL, para no abortar una partida que en realidad terminó.
//
// UN SOLO PROCESO A LA VEZ (el lease `interrupted-matches`), al arrancar y cada `intervalMs`: el
// proceso que murió puede no volver nunca.

/** Lo que el registro guarda de una partida abierta y la recuperación necesita para abortarla. */
export interface OpenMatch {
  readonly matchId: string;
  readonly roomId: string;
  readonly mode: MatchMode;
  readonly tournamentId?: string;
  readonly gameModeId: string;
  readonly userIds: readonly string[];
}

/** Lo que la recuperación le pide al registro de partidas (`MongoHistory`). */
export interface OpenMatchBacklog {
  /** Abiertas y sin escribir desde antes de `updatedBefore`, sin marca de recuperación; la más vieja primero. */
  staleOpen(updatedBefore: Date, limit: number): Promise<OpenMatch[]>;
  /**
   * La cierra como abortada `INTERRUPTED` con la marca `recovery`, SÓLO si sigue abierta.
   * @returns si la cerró (falso: alguien la cerró antes).
   */
  closeInterrupted(matchId: string, at: Date): Promise<boolean>;
  /** Abierta pero con su desenlace ya en el outbox (su cierre del registro se perdió): sólo la marca. */
  markResolved(matchId: string, at: Date, outcome: "finished" | "aborted"): Promise<void>;
}

/** Lo que la recuperación le pregunta al registro del clúster (`MatchRegistry`). */
export interface MatchLiveness {
  isLive(matchId: string): Promise<boolean>;
  resultHeld(matchId: string): Promise<boolean>;
}

export interface InterruptedMatchRecoveryDeps {
  readonly backlog: OpenMatchBacklog;
  readonly liveness: MatchLiveness;
  readonly outbox: Required<MatchResultOutbox>;
  readonly wake: () => void;
  readonly lease: Lease;
  readonly now: () => number;
  readonly log: Logger;
  readonly graceMs?: number;
  readonly intervalMs?: number;
  readonly batch?: number;
  // Trabajo de mantenimiento que va en la misma pasada y bajo el mismo lease: la compactación del outbox.
  readonly maintenance?: () => Promise<void>;
}

export const RECOVERY_LEASE = "interrupted-matches";
export const RECOVERY_GRACE_MS = 10 * 60_000;
export const RECOVERY_INTERVAL_MS = 2 * 60_000;
const RECOVERY_LEASE_TTL_MS = 60_000;
const RECOVERY_BATCH = 100;

export class InterruptedMatchRecovery {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<number>;

  constructor(private readonly deps: InterruptedMatchRecoveryDeps) {}

  /** Una pasada ya (el arranque) y después cada `intervalMs`. */
  start(): void {
    if (this.timer) return;
    this.run();
    const timer = setInterval(() => this.run(), this.deps.intervalMs ?? RECOVERY_INTERVAL_MS);
    timer.unref?.();
    this.timer = timer;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => 0);
  }

  private run(): void {
    void this.pass().catch((error: unknown) =>
      this.deps.log.error("recuperación de partidas interrumpidas: la pasada falló", {
        error: String(error),
      }),
    );
  }

  /** @returns cuántas partidas abortó. Una sola pasada por proceso a la vez; entre procesos, el lease. */
  pass(): Promise<number> {
    this.running ??= this.passOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async passOnce(): Promise<number> {
    const recovered = await this.deps.lease.within(RECOVERY_LEASE, RECOVERY_LEASE_TTL_MS, () =>
      this.recover(),
    );
    return recovered ?? 0;
  }

  private async recover(): Promise<number> {
    const { backlog, liveness, outbox, log, now } = this.deps;
    const cutoff = new Date(now() - (this.deps.graceMs ?? RECOVERY_GRACE_MS));
    const candidates = await backlog.staleOpen(cutoff, this.deps.batch ?? RECOVERY_BATCH);
    let recovered = 0;
    for (const match of candidates) {
      const finishedKey = `${match.matchId}:finished`;
      const abortedKey = `${match.matchId}:aborted`;
      const at = new Date(now());
      const present = await outbox.present([finishedKey, abortedKey]);
      if (present.size > 0) {
        await backlog.markResolved(
          match.matchId,
          at,
          present.has(finishedKey) ? "finished" : "aborted",
        );
        continue;
      }
      // «No sé» de Redis sube y corta la pasada: nunca se aborta una partida que quizá vive.
      if (await liveness.isLive(match.matchId)) continue;
      if (await liveness.resultHeld(match.matchId)) continue;
      const payload: MatchAbortedPayload = {
        gameSlug: "domino",
        mode: match.mode,
        ...(match.mode === "TOURNAMENT" && match.tournamentId !== undefined
          ? { tournamentId: match.tournamentId }
          : {}),
        matchId: match.matchId,
        roomId: match.roomId,
        gameModeId: match.gameModeId,
        abortedAt: at.toISOString(),
        reason: "INTERRUPTED",
        participants: match.userIds.map((userId) => ({ userId })),
      };
      const inserted = await outbox.enqueue(abortedKey, MATCH_ABORTED_KEY, payload, {
        exclusiveKey: match.matchId,
      });
      if (!inserted) {
        // OTRO DESENLACE GANÓ entre la pregunta y el insert: ése es el que se publica.
        const now2 = await outbox.present([finishedKey, abortedKey]);
        await backlog.markResolved(
          match.matchId,
          at,
          now2.has(finishedKey) ? "finished" : "aborted",
        );
        continue;
      }
      recovered += 1;
      const closed = await backlog.closeInterrupted(match.matchId, at);
      log.warn("partida interrumpida: su proceso murió sin cerrarla; se publica abortada", {
        matchId: match.matchId,
        roomId: match.roomId,
        closedRecord: closed,
      });
      if (!closed) {
        log.error("partida interrumpida: el registro ya tenía otro cierre; revisar a mano", {
          matchId: match.matchId,
        });
      }
    }
    if (recovered > 0) this.deps.wake();
    await this.deps.maintenance?.().catch((error: unknown) =>
      log.warn("recuperación de partidas interrumpidas: el mantenimiento falló", {
        error: String(error),
      }),
    );
    return recovered;
  }
}
