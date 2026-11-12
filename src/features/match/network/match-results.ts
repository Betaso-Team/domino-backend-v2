import type { Logger } from "@/shared/logger";
import { UC } from "@/shared/money";
import { type DominoMatchConfig, type MatchMode, modeOf } from "../core/config";
import type { MatchState } from "../core/state";
import { ucText } from "./amounts";
import type { AbortReason, NetworkMatchEvent } from "./events";
import type { MatchEventSink } from "./listeners";
import { payoutOf } from "./payout";

// EL RESULTADO DE UNA MESA DEL ORQUESTADOR, como hecho que dominó le publica. Es la mitad de dominó
// del contrato `2026-10-05-dinero-mock-resultados-y-reportes-design` (games-orchestrator): exchange
// `tablea_gaming`, routing keys `domino.match.finished` / `domino.match.aborted`.
//
// DOMINÓ NO MUEVE DINERO, Y TAMPOCO LO OMITE: dice qué pasó. El premio sí viaja —la regla de quién
// cobra y cuánto es del juego (`payoutOf`)—, y los reembolsos NO: el orquestador devuelve lo que
// su ficha dice que cobró, que es lo único que sabe con certeza quién pagó.
//
// TODA MESA lo publica: el orquestador es la única puerta de entrada, así que toda mesa es suya.

export const MATCH_RESULT_EXCHANGE = "tablea_gaming";
export const MATCH_FINISHED_KEY = "domino.match.finished";
export const MATCH_ABORTED_KEY = "domino.match.aborted";
export type MatchResultKey = typeof MATCH_FINISHED_KEY | typeof MATCH_ABORTED_KEY;

// Los motivos de una mesa que se cierra sin veredicto, más el que solo una mesa del orquestador
// tiene: el orquestador no pudo cobrar la entrada y la mesa no arrancó.
export type MatchAbortReason = AbortReason | "CHARGE_REJECTED";

/**
 * CÓMO TERMINÓ, más fino que `reason`: por puntos con la última mano dominada o trancada, o por
 * abandono del equipo perdedor, rendido (`ABANDON` dicho por él) o retirado por el reloj. Si en el
 * equipo perdedor alguien se rindió, es `ABANDONMENT_VOLUNTARY` aunque otro se haya ido por tiempo.
 */
export type MatchFinishDetail =
  | "SCORE_DOMINO"
  | "SCORE_BLOCKED"
  | "ABANDONMENT_VOLUNTARY"
  | "ABANDONMENT_TIMEOUT";

/**
 * Cómo dejó la mesa un participante: rendido (`voluntary`), retirado por el reloj conectado (`timeout`)
 * o retirado por el reloj con el socket caído (`disconnected`); `null` si la terminó sentado.
 */
export type ParticipantAbandon = "voluntary" | "timeout" | "disconnected" | null;

// LOS CAMPOS DE ABAJO MARCADOS «aditivo» llegaron con los torneos (2026-11). Los consumidores parsean
// sin `strict`, así que un consumidor viejo los ignora; los de antes no cambian.
export interface MatchFinishedPayload {
  readonly gameSlug: "domino";
  /** aditivo: `CASUAL` (del catálogo, con dinero) o `TOURNAMENT` (gratis, de un torneo). */
  readonly mode: MatchMode;
  /** aditivo: solo en una mesa de torneo. */
  readonly tournamentId?: string;
  readonly matchId: string;
  readonly roomId: string;
  readonly gameModeId: string;
  readonly rateId: string;
  /** aditivo: cuándo arrancó el juego (el primer reparto); `null` si nunca arrancó. */
  readonly startedAt: string | null;
  readonly endedAt: string;
  readonly reason: "SCORE" | "ABANDONMENT";
  /** aditivo */
  readonly endReason: MatchFinishDetail;
  /** aditivo: manos cerradas (`pastRounds`); la que se cortó por un abandono no cuenta. */
  readonly roundsPlayed: number;
  /** aditivo: el marcador final por equipo. */
  readonly finalScore: { readonly A: number; readonly B: number };
  /**
   * LOS MONTOS EN LA CONVENCIÓN v2 (`network/amounts.ts`): una entidad en UC, `currency: "UC"` y cada
   * monto como texto con 4 decimales (`"2.0000"`), donde antes iba el número en UC (y en v1, el objeto
   * `{ uc }`). Está en UC porque la mesa es de todos sus asientos, y el orquestador tiene la cotización de
   * cada uno en su planilla, con el `rateId` de arriba. `multiplier` y `bet.extra` NO son plata —pesos
   * de los puntos del ranking— y siguen siendo números. El orquestador lee las tres formas (su lector
   * tolerante, unidad 1a).
   */
  readonly stakes: {
    readonly currency: typeof UC;
    readonly entryFee: string;
    readonly prize: string;
    readonly multiplier: number;
    readonly isFreeRoom: boolean;
    readonly bet: { readonly level: number; readonly extra: number } | null;
  };
  readonly participants: readonly {
    readonly userId: string;
    readonly teamId: string;
    readonly result: "won" | "lost" | "abandoned";
    /** aditivo */
    readonly abandon: ParticipantAbandon;
    /**
     * Segundos que jugó: desde `startedAt` hasta que se fue (`leftAt`) o, si terminó sentado, hasta
     * `endedAt`; entero hacia abajo, nunca negativo, y `0` si el juego nunca arrancó.
     */
    readonly playedSeconds: number;
  }[];
  /**
   * Cada premio es una entidad en UC: `{ userId, currency: "UC", amount: "36.0000" }`. Antes fue
   * `amountUc: number` y, en v1, `amount: { uc }`; el orquestador lee las tres.
   */
  readonly payouts: readonly {
    readonly userId: string;
    readonly currency: typeof UC;
    readonly amount: string;
  }[];
}

export interface MatchAbortedPayload {
  readonly gameSlug: "domino";
  /** aditivo */
  readonly mode: MatchMode;
  /** aditivo: solo en una mesa de torneo. */
  readonly tournamentId?: string;
  readonly matchId: string;
  readonly roomId: string;
  readonly gameModeId: string;
  readonly abortedAt: string;
  readonly reason: MatchAbortReason;
  readonly participants: readonly { readonly userId: string }[];
}

export type MatchResultPayload = MatchFinishedPayload | MatchAbortedPayload;

export interface MatchResult {
  readonly routingKey: MatchResultKey;
  // `<matchId>:finished|aborted`: el `messageId` del mensaje y la clave de deduplicación del outbox.
  // Una mesa tiene UN desenlace, así que una segunda proyección del mismo cierre no encola nada.
  readonly key: string;
  readonly payload: MatchResultPayload;
}

/**
 * El desenlace de una mesa como resultado publicable, o `undefined` si el evento no es un desenlace.
 * Pura: el instante entra por parámetro.
 */
export function matchResultOf(
  event: NetworkMatchEvent,
  match: MatchState,
  config: DominoMatchConfig,
  roomId: string,
  at: Date,
  abortReason?: MatchAbortReason,
): MatchResult | undefined {
  const mode = modeOf(config);
  const base = {
    gameSlug: "domino",
    mode,
    ...(mode === "TOURNAMENT" && config.tournamentId !== undefined
      ? { tournamentId: config.tournamentId }
      : {}),
    matchId: config.matchId,
    roomId,
    gameModeId: config.gameModeId,
  } as const;
  if (event.type === "MATCH_ABORTED") {
    return {
      routingKey: MATCH_ABORTED_KEY,
      key: `${config.matchId}:aborted`,
      payload: {
        ...base,
        abortedAt: at.toISOString(),
        reason: abortReason ?? event.reason,
        participants: config.seats.map(({ userId }) => ({ userId })),
      },
    };
  }
  if (event.type !== "MATCH_RESOLVED") return undefined;
  // EL PREMIO SALE DE `payoutOf` Y NO SE RECALCULA ACÁ: es la única regla de quién cobra
  // (bots y retirados no; el aumento aceptado adentro), y dos copias derivan.
  const reward = payoutOf(event, match, config);
  const userOf = new Map(config.seats.map((seat) => [seat.playerId, seat.userId]));
  const endedAt = at.getTime();
  return {
    routingKey: MATCH_FINISHED_KEY,
    key: `${config.matchId}:finished`,
    payload: {
      ...base,
      rateId: config.rateId,
      startedAt: match.startedAt > 0 ? new Date(match.startedAt).toISOString() : null,
      endedAt: at.toISOString(),
      reason: event.reason,
      endReason: endReasonOf(event, match),
      roundsPlayed: match.pastRounds.length,
      finalScore: { A: match.scoreboard?.teamA ?? 0, B: match.scoreboard?.teamB ?? 0 },
      stakes: {
        currency: UC,
        entryFee: ucText(config.entryFee),
        prize: ucText(config.prize),
        multiplier: config.multiplier,
        isFreeRoom: config.isFreeRoom,
        bet:
          match.acceptedBetLevel > 0
            ? { level: match.acceptedBetLevel, extra: match.acceptedBetExtra }
            : null,
      },
      participants: match.players.map((player) => ({
        userId: userOf.get(player.playerId) ?? player.userId,
        teamId: player.teamId,
        // EL ASIENTO QUE JUEGA LA MÁQUINA ES DEL QUE SE FUE: no ganó, abandonó. Sin esto, en 4P el
        // reporte le sumaría una victoria a quien dejó la mesa.
        result:
          player.hasAbandoned || player.isBot
            ? "abandoned"
            : player.teamId === event.winnerTeamId
              ? "won"
              : "lost",
        abandon: abandonOf(player),
        playedSeconds: playedSecondsOf(match.startedAt, player.leftAt, endedAt),
      })),
      // `ucText` no redondea: el orquestador lee `amount` como decimal y lo compara EXACTO con
      // `stakeAt(prize, nivel)`, la misma fórmula y el mismo `Decimal` con que `payoutOf` lo calculó.
      payouts: (reward?.entries ?? []).map(({ userId, amount }) => ({
        userId,
        currency: UC,
        amount: ucText(amount),
      })),
    },
  };
}

/**
 * Cómo se fue un asiento, si se fue: rendido, retirado por el reloj (conectado o con el socket caído),
 * o (`null`) terminó sentado.
 */
function abandonOf(player: {
  hasAbandoned: boolean;
  isBot: boolean;
  leftBy: string;
}): ParticipantAbandon {
  if (!player.hasAbandoned && !player.isBot) return null;
  // Un asiento retirado siempre tiene `leftBy` (lo escribe `MatchPlayer`); si faltara, el reloj es lo
  // único que retira sin que nadie lo pida.
  if (player.leftBy === "voluntary" || player.leftBy === "disconnected") return player.leftBy;
  return "timeout";
}

/**
 * LOS SEGUNDOS QUE JUGÓ UN PARTICIPANTE: `floor((hasta − startedAt) / 1000)`, donde `hasta` es cuándo
 * se fue (`leftAt`) o, si terminó sentado, el cierre. `0` si el juego nunca arrancó (`startedAt` en
 * cero) y nunca negativo: alguien retirado antes del primer reparto no jugó nada.
 */
function playedSecondsOf(startedAt: number, leftAt: number, endedAt: number): number {
  if (startedAt <= 0) return 0;
  const until = leftAt > 0 ? leftAt : endedAt;
  return Math.max(0, Math.floor((until - startedAt) / 1000));
}

function endReasonOf(
  event: Extract<NetworkMatchEvent, { type: "MATCH_RESOLVED" }>,
  match: MatchState,
): MatchFinishDetail {
  if (event.reason === "SCORE") {
    return match.pastRounds.at(-1)?.reason === "BLOCKED" ? "SCORE_BLOCKED" : "SCORE_DOMINO";
  }
  const losers = match.players.filter((player) => player.teamId !== event.winnerTeamId);
  // Un retiro con el socket caído es del reloj, como el `timeout`: cierra `ABANDONMENT_TIMEOUT`.
  return losers.some((player) => abandonOf(player) === "voluntary")
    ? "ABANDONMENT_VOLUNTARY"
    : "ABANDONMENT_TIMEOUT";
}

// LO QUE LA PIEZA NECESITA DEL OUTBOX: encolar y despertar al despachador. Encolar es idempotente por
// clave, así que reintentar es seguro. `exclusiveKey` es el `matchId`: una partida tiene un solo
// desenlace en el outbox (`finished` O `aborted`), y el segundo lo rechaza la base.
export interface MatchResultOutbox {
  enqueue(
    dedupeKey: string,
    routingKey: MatchResultKey,
    payload: MatchResultPayload,
    options?: { readonly exclusiveKey?: string },
  ): Promise<boolean>;
  // Cuáles de estas claves ya están: distingue «ya estaba el mío» de «estaba el OTRO desenlace».
  present?(keys: readonly string[]): Promise<ReadonlySet<string>>;
}

/**
 * LA MARCA COMPARTIDA DE «TENGO ESTE RESULTADO EN MEMORIA Y NO PUDE ENCOLARLO». La pone el primer
 * fallo y la renueva cada reintento (con plazo: si el proceso muere, vence sola); la quita el encolado.
 * La recuperación de partidas interrumpidas (`interrupted-matches.ts`) no toca una partida marcada:
 * su desenlace verdadero está por entrar. Los fallos de la marca se tragan: es una precaución.
 */
export interface PendingResultMarks {
  hold(matchId: string): Promise<void>;
  release(matchId: string): Promise<void>;
}

export interface MatchResultRecorderDeps {
  readonly outbox: MatchResultOutbox;
  readonly wake: () => void;
  readonly now: () => number;
  readonly log: Logger;
  readonly marks?: PendingResultMarks;
  // Para la suite: cuánto espera el primer reintento.
  readonly retryBaseMs?: number;
}

// Reintento de un encolado que falló (Mongo caído): duplica hasta un minuto y NO SE RINDE mientras el
// proceso vive. Un resultado que no llega al outbox es un premio que no se paga.
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
// DURANTE EL APAGADO se reintenta seguido: queda poco tiempo y cada intento es un resultado que se salva.
const DRAIN_RETRY_MS = 250;
// EL PLAZO DEL DRENADO: el cobro del aumento en vuelo (15 s, `OrchestratorBetCharger`) más cinco
// segundos de reintentos. `kill_timeout` (pm2) y `stop_grace_period` (Docker) lo cubren con margen.
export const RESULT_DRAIN_DEADLINE_MS = 20_000;

/**
 * EL QUE ESCRIBE EL RESULTADO EN EL OUTBOX, enganchado como sink de la sala. El motor es síncrono y
 * el outbox no: el sink arranca el trabajo y no lo espera, como el cobro del aumento.
 *
 * CADA RESULTADO ES UN BUCLE que vive hasta que entra al outbox (o hasta que el apagado se rinde), y el
 * bucle entero —no sólo su primer intento— está en `pending`: `drain()` lo espera.
 */
export class MatchResultRecorder {
  private readonly pending = new Set<Promise<void>>();
  // LO QUE TODAVÍA NO ENTRÓ, por clave: lo que el apagado escribe en el log si se rinde.
  private readonly unsaved = new Map<string, MatchResult>();
  // Los bucles dormidos entre reintentos: el drenado los despierta.
  private readonly sleepers = new Set<() => void>();
  private draining = false;
  private abandoned = false;

  constructor(private readonly deps: MatchResultRecorderDeps) {}

  /**
   * @param abortReason el motivo que la SALA sabe y el evento no (`CHARGE_REJECTED`). Se consulta al
   * cerrar, no al armar el sink: el cobro rechazado ocurre después de que la mesa nació.
   * @param settledBet resuelve cuando el cobro del aumento en vuelo terminó. El desenlace lo espera
   * ANTES de leer el aumento del estado: con el cobro todavía en vuelo, el estado dice x2 aunque el
   * orquestador vaya a contestar que no, y el premio saldría multiplicado sin que nadie lo pagara.
   * Para cuando resuelve, un cobro fallido ya anuló el trato.
   */
  sinkFor(
    config: DominoMatchConfig,
    match: MatchState,
    roomId: string,
    abortReason: () => MatchAbortReason | undefined = () => undefined,
    settledBet: () => Promise<void> = () => Promise.resolve(),
  ): MatchEventSink {
    return (events) => {
      for (const event of events) {
        // El instante y el motivo son los del cierre, no los de después de la espera. Se proyecta YA
        // aunque haya que esperar: una invariante rota (`payoutOf`) sigue lanzando adentro del
        // comando, que es lo que cierra la mesa, y no como una promesa rechazada que nadie mira.
        const at = new Date(this.deps.now());
        const reason = abortReason();
        const result = matchResultOf(event, match, config, roomId, at, reason);
        if (!result) continue;
        // Desde ya es «no guardado»: si el apagado se rinde esperando el cobro, al menos esto queda.
        this.unsaved.set(result.key, result);
        // Una mesa abortada no lleva montos, así que no tiene nada que esperar.
        if (event.type !== "MATCH_RESOLVED") {
          this.track(this.record(result));
          continue;
        }
        this.track(
          settledBet().then(() => {
            // Releído con el cobro ya resuelto: si no se pudo, el trato ya está anulado en el estado.
            const settled = matchResultOf(event, match, config, roomId, at, reason) ?? result;
            this.unsaved.set(settled.key, settled);
            return this.record(settled);
          }),
        );
      }
    };
  }

  /**
   * ESPERA HASTA QUE TODO LO PENDIENTE ENTRE AL OUTBOX, reintentando seguido, o hasta el plazo. Al
   * vencer se rinde: escribe en el log, a nivel `error` y con el cuerpo ENTERO, cada resultado que no
   * entró —para reproducirlo a mano, ver «Resultados que no llegaron al outbox» en
   * `docs/operacion.md`— y resuelve. Nunca rechaza.
   */
  async drain(deadlineMs = RESULT_DRAIN_DEADLINE_MS): Promise<void> {
    this.draining = true;
    for (const wake of [...this.sleepers]) wake();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), deadlineMs);
    });
    try {
      while (this.pending.size > 0) {
        const done = Promise.all([...this.pending]).then(() => "done" as const);
        if ((await Promise.race([done, late])) === "late") break;
      }
    } finally {
      clearTimeout(timer);
    }
    if (this.unsaved.size === 0) return;
    this.abandoned = true;
    for (const wake of [...this.sleepers]) wake();
    for (const result of this.unsaved.values()) {
      this.deps.log.error(
        "resultado de partida SIN ENCOLAR: el apagado se rindió; reproducir a mano",
        {
          key: result.key,
          routingKey: result.routingKey,
          payload: result.payload,
        },
      );
    }
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  // EL BUCLE DE UN RESULTADO. Nunca rechaza.
  private async record(result: MatchResult): Promise<void> {
    const { outbox, log, marks } = this.deps;
    const matchId = result.payload.matchId;
    for (let attempt = 0; !this.abandoned; attempt += 1) {
      try {
        const inserted = await outbox.enqueue(result.key, result.routingKey, result.payload, {
          exclusiveKey: matchId,
        });
        if (!inserted) await this.explainDuplicate(result);
        this.unsaved.delete(result.key);
        if (attempt > 0) await marks?.release(matchId).catch(() => undefined);
        this.deps.wake();
        return;
      } catch (error) {
        await marks?.hold(matchId).catch(() => undefined);
        const base = this.deps.retryBaseMs ?? RETRY_BASE_MS;
        const delay = this.draining
          ? Math.min(DRAIN_RETRY_MS, base)
          : Math.min(RETRY_MAX_MS, base * 2 ** attempt);
        log.error("no se pudo encolar el resultado de la partida; se reintenta", {
          key: result.key,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(error),
        });
        await this.sleep(delay);
      }
    }
  }

  // `false` DE `enqueue`: o ya estaba el mismo (un reintento cuyo primer intento sí llegó) o estaba el
  // OTRO desenlace de la partida. Lo segundo no debería pasar nunca desde una sala —una sala emite un
  // solo desenlace— y sí puede pasar si la recuperación de partidas interrumpidas se adelantó: el
  // desenlace que ganó es el que se publica, y éste se escribe entero en el log para revisarlo a mano.
  private async explainDuplicate(result: MatchResult): Promise<void> {
    const present = await this.deps.outbox.present?.([result.key]);
    if (!present || present.has(result.key)) return;
    this.deps.log.error("la partida ya tenía el OTRO desenlace en el outbox; éste no se publica", {
      key: result.key,
      routingKey: result.routingKey,
      payload: result.payload,
    });
  }

  // UN SUEÑO QUE EL DRENADO PUEDE CORTAR. `unref`: un reintento no sostiene vivo al proceso; el que
  // tiene que esperar es `drain()`.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      timer.unref?.();
      this.sleepers.add(wake);
    });
  }
}
