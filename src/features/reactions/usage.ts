import type { Logger } from "@/logger";
import type { ReactionSent } from "./relay";

// EL REGISTRO DE USO DE LAS REACCIONES, para BI (UA-GAM-DOM-004 de v1): cada gesto que salió a una mesa
// y cada vez que un jugador silenció o reactivó los gestos. Es un registro y no un hecho de la partida:
// no entra en el historial ni en el resultado, y si no se puede escribir la mesa sigue igual.
//
// Las colecciones y los nombres de campo son los de v1 (`domino_reaction_events`,
// `domino_reaction_mute_events`), sin la muestra: se registra a todos los jugadores, sin flag. La forma
// en la base es del adaptador (`transports/mongo-reaction-usage.ts`); acá va el vocabulario del código.

/** Qué mesa era, en los términos de v1: con dinero, gratis o de un torneo. */
export type ReactionGameKind = "paga" | "gratuita" | "torneo";

/** Un gesto que salió a la mesa. */
export interface ReactionUsageRecord {
  /** Lo genera el servidor (uuid): un gesto es un hecho único aunque se repita el mismo emoji. */
  readonly eventId: string;
  /** El `userId` de Tablea del que lo mandó. */
  readonly userId: string;
  readonly providerId: string;
  readonly matchId: string;
  readonly gameKind: ReactionGameKind;
  readonly reactionId: string;
  /** El contenido que salió a la mesa (`Reaction.content`). */
  readonly emoji: string;
  readonly at: Date;
}

/** Un jugador silenció (`muted: true`) o reactivó los gestos de la mesa. */
export interface MuteChangeRecord {
  /** Lo genera el CLIENTE: un reenvío con el mismo id es el mismo cambio y no se cuenta dos veces. */
  readonly eventId: string;
  readonly userId: string;
  readonly providerId: string;
  readonly muted: boolean;
  /** Desde dónde se cambió. Hoy sólo desde la mesa. */
  readonly origin: "partida";
  readonly matchId: string;
  readonly at: Date;
}

/**
 * DONDE SE ESCRIBE EL USO. **Nunca rechaza**: un fallo se loguea y se traga, porque un registro de BI
 * no puede tirar una mesa con dinero. Un cambio de silencio con un `eventId` ya guardado se ignora.
 */
export interface ReactionUsageStore {
  recordReaction(record: ReactionUsageRecord): Promise<void>;
  recordMuteChange(record: MuteChangeRecord): Promise<void>;
}

/** Quién es cada asiento de la mesa fuera de ella: el `seat-N` no le dice nada a BI. */
export interface ReactionTableSeat {
  readonly userId: string;
  readonly providerId: string;
}

/** La mesa, como la ve el registro. La arma el transporte de `match`, que es quien la conoce. */
export interface ReactionTable {
  readonly matchId: string;
  readonly gameKind: ReactionGameKind;
  /** Por `seat-N` (el `playerId` del asiento). */
  readonly seats: ReadonlyMap<string, ReactionTableSeat>;
}

export interface ReactionUsageLogDeps {
  readonly store: ReactionUsageStore;
  readonly table: ReactionTable;
  readonly now: () => Date;
  readonly newEventId: () => string;
  readonly log: Logger;
}

/**
 * EL REGISTRO DE UNA MESA: traduce «el asiento N hizo tal cosa» a una fila con el jugador, su proveedor
 * y la mesa. No lanza nunca: un asiento que la mesa no conoce no se registra y queda en el log.
 */
export class ReactionUsageLog {
  constructor(private readonly deps: ReactionUsageLogDeps) {}

  /** Un gesto que YA salió a la mesa. Se escribe sin esperar: la mesa no espera a BI. */
  reactionRelayed(sent: ReactionSent): void {
    const seat = this.seatOf(sent.fromPlayerId);
    if (!seat) return;
    void this.deps.store.recordReaction({
      eventId: this.deps.newEventId(),
      userId: seat.userId,
      providerId: seat.providerId,
      matchId: this.deps.table.matchId,
      gameKind: this.deps.table.gameKind,
      reactionId: sent.reaction.id,
      emoji: sent.reaction.content,
      at: this.deps.now(),
    });
  }

  /** El jugador silenció o reactivó los gestos, desde la mesa. */
  async muteChanged(
    playerId: string,
    change: { readonly muted: boolean; readonly eventId: string },
  ): Promise<void> {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    await this.deps.store.recordMuteChange({
      eventId: change.eventId,
      userId: seat.userId,
      providerId: seat.providerId,
      muted: change.muted,
      origin: "partida",
      matchId: this.deps.table.matchId,
      at: this.deps.now(),
    });
  }

  private seatOf(playerId: string): ReactionTableSeat | undefined {
    const seat = this.deps.table.seats.get(playerId);
    if (!seat)
      this.deps.log.warn("uso de reacciones: asiento desconocido, no se registra", { playerId });
    return seat;
  }
}
