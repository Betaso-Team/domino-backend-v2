import type { Logger } from "@/shared/logger";
import type { DominoMatchConfig } from "../core/config";
import type { MatchState } from "../core/state";
import type { AbortReason, NetworkMatchEvent } from "./events";
import type { MatchEventSink } from "./listeners";
import { settlementOf } from "./settlement";

// EL RESULTADO DE UNA MESA DEL ORQUESTADOR, como hecho que dominó le publica. Es la mitad de dominó
// del contrato `2026-10-05-dinero-mock-resultados-y-reportes-design` (games-orchestrator): exchange
// `betaso_games`, routing keys `domino.match.finished` / `domino.match.aborted`.
//
// DOMINÓ NO MUEVE DINERO, Y TAMPOCO LO OMITE: dice qué pasó. El premio sí viaja —la regla de quién
// cobra y cuánto es del juego (`settlementOf`)—, y los reembolsos NO: el orquestador devuelve lo que
// su ficha dice que cobró, que es lo único que sabe con certeza quién pagó.
//
// SOLO LAS MESAS POR REQUEST lo publican. Las del lobby propio de dominó liquidan contra Betaso por
// su propio camino (`network/platform.ts`), y publicar las dos cosas sería pagar dos veces.

export const MATCH_RESULT_EXCHANGE = "betaso_games";
export const MATCH_FINISHED_KEY = "domino.match.finished";
export const MATCH_ABORTED_KEY = "domino.match.aborted";
export type MatchResultKey = typeof MATCH_FINISHED_KEY | typeof MATCH_ABORTED_KEY;

// Los motivos de una mesa que se cierra sin veredicto, más el que solo una mesa del orquestador
// tiene: el orquestador no pudo cobrar la entrada y la mesa no arrancó.
export type MatchAbortReason = AbortReason | "CHARGE_REJECTED";

export interface MatchFinishedPayload {
  readonly gameSlug: "domino";
  readonly matchId: string;
  readonly roomId: string;
  readonly gameModeId: string;
  readonly rateId: string;
  readonly endedAt: string;
  readonly reason: "SCORE" | "ABANDONMENT";
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
  }[];
  readonly settlement: readonly { readonly userId: string; readonly amountUc: number }[];
}

export interface MatchAbortedPayload {
  readonly gameSlug: "domino";
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
  const base = {
    gameSlug: "domino",
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
  // EL PREMIO SALE DE `settlementOf` Y NO SE RECALCULA ACÁ: es la única regla de quién cobra
  // (bots y retirados no; el aumento aceptado adentro), y dos copias derivan.
  const reward = settlementOf(event, match, config);
  const userOf = new Map(config.seats.map((seat) => [seat.playerId, seat.userId]));
  return {
    routingKey: MATCH_FINISHED_KEY,
    key: `${config.matchId}:finished`,
    payload: {
      ...base,
      rateId: config.rateId,
      endedAt: at.toISOString(),
      reason: event.reason,
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
      })),
      settlement: (reward?.entries ?? []).map(({ userId, amount }) => ({
        userId,
        amountUc: amount,
      })),
    },
  };
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
  constructor(private readonly deps: MatchResultRecorderDeps) {}

  /**
   * @param abortReason el motivo que la SALA sabe y el evento no (`CHARGE_REJECTED`). Se consulta al
   * cerrar, no al armar el sink: el cobro rechazado ocurre después de que la mesa nació.
   */
  sinkFor(
    config: DominoMatchConfig,
    match: MatchState,
    roomId: string,
    abortReason: () => MatchAbortReason | undefined = () => undefined,
  ): MatchEventSink {
    return (events) => {
      for (const event of events) {
        const result = matchResultOf(
          event,
          match,
          config,
          roomId,
          new Date(this.deps.now()),
          abortReason(),
        );
        if (result) this.record(result, 0);
      }
    };
  }

  private record(result: MatchResult, attempt: number): void {
    this.deps.outbox.enqueue(result.key, result.routingKey, result.payload).then(
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
