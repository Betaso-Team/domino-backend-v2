import type { Logger } from "@/logger";
import {
  type Collection,
  type Document,
  type IndexDescription,
  MongoServerError,
  type OptionalUnlessRequiredId,
} from "mongodb";
import type { MuteChangeRecord, ReactionUsageRecord, ReactionUsageStore } from "../usage";

// EL REGISTRO DE USO EN MONGO, con las colecciones y los campos de v1 (UA-GAM-DOM-004), sin la muestra.
// Lo lee BI, así que los nombres son el contrato: no se cambian sin avisar. El nombre de cada colección
// es una constante del código, como el del registro de partidas.
export const REACTION_EVENTS_COLLECTION = "domino_reaction_events";
export const REACTION_MUTE_EVENTS_COLLECTION = "domino_reaction_mute_events";

/** `domino_reaction_events`: un gesto que salió a la mesa. */
export interface ReactionEventDocument {
  id_evento: string;
  /** El `userId` de Tablea. */
  id_jugador: string;
  id_proveedor: string;
  id_partida: string;
  tipo_juego: "paga" | "gratuita" | "torneo";
  id_reaccion: string;
  codigo_emoji: string;
  fecha_hora: Date;
}

/** `domino_reaction_mute_events`: un jugador silenció o reactivó los gestos. */
export interface ReactionMuteEventDocument {
  /** Lo genera el cliente; único, así que un reenvío no suma una fila. */
  id_evento: string;
  id_jugador: string;
  id_proveedor: string;
  accion: "silenciar" | "reactivar";
  origen: "partida";
  id_partida: string;
  fecha_hora: Date;
}

// LOS ÍNDICES, iguales en las dos: `id_evento` único (en los gestos lo genera el servidor y no choca
// nunca; en el silencio es lo que descarta el reenvío) y los dos por los que BI recorta, la fecha y el
// jugador. Nombrados: `createIndexes` es idempotente mientras nombre y clave coincidan.
export const REACTION_USAGE_INDEXES: readonly IndexDescription[] = [
  { key: { id_evento: 1 }, name: "id_evento_1", unique: true },
  { key: { fecha_hora: 1 }, name: "fecha_hora_1" },
  { key: { id_jugador: 1 }, name: "id_jugador_1" },
];

const DUPLICATE_KEY = 11000;

// EL CÓDIGO NUMÉRICO Y NO EL MENSAJE, como en `mongo-player-stats.ts`.
const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError
    ? error.code === DUPLICATE_KEY
    : typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === DUPLICATE_KEY;

/** Lo que este adaptador necesita de `Mongo` (`@/shared/mongo`), que lo satisface por estructura. */
export interface ReactionUsageMongo {
  collection<T extends Document>(name: string): Promise<Collection<T>>;
}

/**
 * UNA ESCRITURA QUE FALLA SE LOGUEA Y SE TRAGA: es un registro de BI y no puede tirar una mesa. Los
 * índices se piden UNA vez por proceso y colección (el adaptador es un singleton del container) y se
 * esperan antes de la primera escritura: sin el único, el silencio repetido entraría dos veces. Si no se
 * pueden crear, se loguea, se escribe igual y el próximo intento los vuelve a pedir.
 */
export class MongoReactionUsage implements ReactionUsageStore {
  private readonly prepared = new Map<string, Promise<void>>();

  constructor(
    private readonly mongo: ReactionUsageMongo,
    private readonly logger: Logger,
  ) {}

  async recordReaction(record: ReactionUsageRecord): Promise<void> {
    await this.insert<ReactionEventDocument>(REACTION_EVENTS_COLLECTION, {
      id_evento: record.eventId,
      id_jugador: record.userId,
      id_proveedor: record.providerId,
      id_partida: record.matchId,
      tipo_juego: record.gameKind,
      id_reaccion: record.reactionId,
      codigo_emoji: record.emoji,
      fecha_hora: record.at,
    });
  }

  async recordMuteChange(record: MuteChangeRecord): Promise<void> {
    await this.insert<ReactionMuteEventDocument>(REACTION_MUTE_EVENTS_COLLECTION, {
      id_evento: record.eventId,
      id_jugador: record.userId,
      id_proveedor: record.providerId,
      accion: record.muted ? "silenciar" : "reactivar",
      origen: record.origin,
      id_partida: record.matchId,
      fecha_hora: record.at,
    });
  }

  private async insert<T extends Document>(name: string, document: T): Promise<void> {
    try {
      const collection = await this.mongo.collection<T>(name);
      await this.prepare(name, collection);
      // El driver pide `OptionalUnlessRequiredId<T>`, que un `T` genérico no satisface aunque los dos
      // documentos no declaren `_id` (lo pone el driver).
      await collection.insertOne(document as OptionalUnlessRequiredId<T>);
    } catch (error) {
      if (isDuplicateKey(error)) {
        this.logger.debug("uso de reacciones: evento repetido, se ignora", {
          collection: name,
          eventId: document.id_evento,
        });
        return;
      }
      this.logger.error("uso de reacciones: no se pudo registrar; la mesa sigue", {
        collection: name,
        eventId: document.id_evento,
        error: String(error),
      });
    }
  }

  private prepare(
    name: string,
    collection: Pick<Collection<Document>, "createIndexes">,
  ): Promise<void> {
    let ready = this.prepared.get(name);
    if (!ready) {
      ready = collection
        .createIndexes([...REACTION_USAGE_INDEXES])
        .then(() => undefined)
        .catch((error: unknown) => {
          this.prepared.delete(name);
          this.logger.error("uso de reacciones: no se pudieron crear los índices; se graba igual", {
            collection: name,
            error: String(error),
          });
        });
      this.prepared.set(name, ready);
    }
    return ready;
  }
}
