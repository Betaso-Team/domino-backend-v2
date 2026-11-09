import type { Logger } from "@/shared/logger";
import { type DominoMatchConfig, type MatchMode, modeOf } from "../core/config";
import type { MatchState } from "../core/state";
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

/** Cómo dejó la mesa un participante; `null` si la terminó sentado. */
export type ParticipantAbandon = "voluntary" | "timeout" | null;

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
  readonly stakes: {
    readonly entryFee: number;
    readonly prize: number;
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
  }[];
  readonly payouts: readonly { readonly userId: string; readonly amountUc: number }[];
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
        entryFee: config.entryFee,
        prize: config.prize,
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
      })),
      payouts: (reward?.entries ?? []).map(({ userId, amount }) => ({
        userId,
        amountUc: amount,
      })),
    },
  };
}

/** Cómo se fue un asiento, si se fue: rendido, retirado por el reloj, o (`null`) terminó sentado. */
function abandonOf(player: { hasAbandoned: boolean; isBot: boolean; leftBy: string }) {
  if (!player.hasAbandoned && !player.isBot) return null;
  // Un asiento retirado siempre tiene `leftBy` (lo escribe `MatchPlayer`); si faltara, el reloj es lo
  // único que retira sin que nadie lo pida.
  return player.leftBy === "voluntary" ? "voluntary" : "timeout";
}

function endReasonOf(
  event: Extract<NetworkMatchEvent, { type: "MATCH_RESOLVED" }>,
  match: MatchState,
): MatchFinishDetail {
  if (event.reason === "SCORE") {
    return match.pastRounds.at(-1)?.reason === "BLOCKED" ? "SCORE_BLOCKED" : "SCORE_DOMINO";
  }
  const losers = match.players.filter((player) => player.teamId !== event.winnerTeamId);
  return losers.some((player) => abandonOf(player) === "voluntary")
    ? "ABANDONMENT_VOLUNTARY"
    : "ABANDONMENT_TIMEOUT";
}

// LO QUE LA PIEZA NECESITA DEL OUTBOX: encolar y despertar al despachador. Encolar es idempotente por
// clave, así que reintentar es seguro.
export interface MatchResultOutbox {
  enqueue(
    dedupeKey: string,
    routingKey: MatchResultKey,
    payload: MatchResultPayload,
  ): Promise<boolean>;
}

export interface MatchResultRecorderDeps {
  readonly outbox: MatchResultOutbox;
  readonly wake: () => void;
  readonly now: () => number;
  readonly log: Logger;
  // Para la suite: cuánto espera el primer reintento.
  readonly retryBaseMs?: number;
}

// Reintento de un encolado que falló (Mongo caído): duplica hasta un minuto y NO SE RINDE. Un
// resultado que no llega al outbox es un premio que no se paga.
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/**
 * EL QUE ESCRIBE EL RESULTADO EN EL OUTBOX, enganchado como sink de la sala. El motor es síncrono y
 * el outbox no: el sink arranca el trabajo y no lo espera, como el cobro del aumento.
 */
export class MatchResultRecorder {
  // Lo que todavía no llegó a su primer encolado: el apagado lo espera antes de cerrar Mongo.
  private readonly pending = new Set<Promise<void>>();

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
        // Una mesa abortada no lleva montos, así que no tiene nada que esperar.
        if (event.type !== "MATCH_RESOLVED") {
          this.track(this.record(result, 0));
          continue;
        }
        this.track(
          settledBet().then(() => {
            // Releído con el cobro ya resuelto: si no se pudo, el trato ya está anulado en el estado.
            const settled = matchResultOf(event, match, config, roomId, at, reason) ?? result;
            return this.record(settled, 0);
          }),
        );
      }
    };
  }

  /** Espera a lo que todavía aguarda un cobro o su primer encolado. No espera los reintentos. */
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private record(result: MatchResult, attempt: number): Promise<void> {
    return this.deps.outbox.enqueue(result.key, result.routingKey, result.payload).then(
      () => this.deps.wake(),
      (error: unknown) => {
        const base = this.deps.retryBaseMs ?? RETRY_BASE_MS;
        const delay = Math.min(RETRY_MAX_MS, base * 2 ** attempt);
        this.deps.log.error("no se pudo encolar el resultado de la partida; se reintenta", {
          key: result.key,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(error),
        });
        const timer: { unref?: () => void } = setTimeout(
          () => this.record(result, attempt + 1),
          delay,
        );
        timer.unref?.();
      },
    );
  }
}
