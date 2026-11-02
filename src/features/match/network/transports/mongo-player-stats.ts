import type { Logger } from "@/logger";
import { type Collection, MongoServerError } from "mongodb";
import { MatchListTimeoutError } from "../history";
import {
  EMPTY_STATS,
  type PlayerStats,
  type PlayerStatsStore,
  type StatsLine,
} from "../player-stats";
import type { HistoryStore } from "./mongo-history";

export const PLAYER_STATS_COLLECTION = "player_stats";

const DUPLICATE_KEY = 11000;
// El mismo plazo que el listado: una base colgada no cuelga /me/stats.
const READ_MAX_TIME_MS = 5_000;
const MAX_TIME_MS_EXPIRED = 50;

// `_id` es el `userId`. `lastEndedAt` es la marca que hace idempotente la escritura.
interface StatsDocument {
  _id: string;
  gamesPlayed?: number;
  gamesWon?: number;
  gamesWonFourPlayers?: number;
  gamesAbandoned?: number;
  currentStreak?: number;
  maxStreak?: number;
  lastEndedAt?: Date;
  updatedAt?: Date;
}

// EL CÓDIGO NUMÉRICO Y NO EL MENSAJE: el texto lo reescribe el servidor el día que quiera.
const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError
    ? error.code === DUPLICATE_KEY
    : typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === DUPLICATE_KEY;

const count = (field: string, step: 0 | 1) => ({ $add: [{ $ifNull: [`$${field}`, 0] }, step] });

// LOS CONTADORES NO SE PUEDEN RECALCULAR, así que `apply` es UNA operación atómica del servidor:
//  - el filtro exige `lastEndedAt < endedAt`: la línea ya aplicada o más vieja NO coincide;
//  - con `upsert`, un no-coincide intenta insertar `_id = userId` y, si el documento existe, choca con
//    E11000 — que es la forma de decir "skipped" sin leer antes (leer y escribir serían dos turnos);
//  - el pipeline suma en la etapa 1 y calcula el máximo de la racha en la 2, que ya ve la racha nueva.
export class MongoPlayerStats implements PlayerStatsStore {
  private readonly now: () => Date;

  constructor(
    private readonly store: HistoryStore,
    private readonly logger: Logger,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async apply(line: StatsLine): Promise<"applied" | "skipped"> {
    const collection = await this.store.collection<StatsDocument>(PLAYER_STATS_COLLECTION);
    try {
      return await this.update(collection, line);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    // UN E11000 NO ES SIEMPRE "YA APLICADA". Con el documento ausente, dos líneas DISTINTAS compiten por
    // el insert y Mongo no reintenta el upsert cuando el filtro lleva `$lt`: la que pierde recibe E11000
    // aunque sea la más nueva (medido: ~la mitad de las carreras). Se repite UNA vez: ahora el documento
    // existe y el filtro `$lt` decide de verdad. Un segundo E11000 sí es "skipped".
    try {
      return await this.update(collection, line);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      this.logger.debug("estadística ya aplicada o más vieja", { userId: line.userId });
      return "skipped";
    }
  }

  private async update(
    collection: Collection<StatsDocument>,
    line: StatsLine,
  ): Promise<"applied" | "skipped"> {
    const won = line.result === "win";
    const result = await collection.updateOne(
      { _id: line.userId, lastEndedAt: { $lt: line.endedAt } },
      [
        {
          $set: {
            gamesPlayed: count("gamesPlayed", 1),
            gamesWon: count("gamesWon", won ? 1 : 0),
            gamesWonFourPlayers: count("gamesWonFourPlayers", won && line.fourPlayers ? 1 : 0),
            gamesAbandoned: count("gamesAbandoned", line.result === "abandoned" ? 1 : 0),
            currentStreak: won ? { $add: [{ $ifNull: ["$currentStreak", 0] }, 1] } : 0,
          },
        },
        {
          $set: {
            maxStreak: { $max: [{ $ifNull: ["$maxStreak", 0] }, "$currentStreak"] },
            lastEndedAt: line.endedAt,
            updatedAt: this.now(),
          },
        },
      ],
      { upsert: true },
    );
    return result.modifiedCount + result.upsertedCount === 1 ? "applied" : "skipped";
  }

  async of(userId: string): Promise<PlayerStats> {
    const collection = await this.store.collection<StatsDocument>(PLAYER_STATS_COLLECTION);
    let found: Partial<StatsDocument> | null;
    try {
      found = await collection.findOne(
        { _id: userId },
        {
          maxTimeMS: READ_MAX_TIME_MS,
          projection: {
            _id: 0,
            gamesPlayed: 1,
            gamesWon: 1,
            gamesWonFourPlayers: 1,
            gamesAbandoned: 1,
            currentStreak: 1,
            maxStreak: 1,
          },
        },
      );
    } catch (error) {
      if (error instanceof MongoServerError && error.code === MAX_TIME_MS_EXPIRED) {
        throw new MatchListTimeoutError(error);
      }
      throw error;
    }
    if (!found) return EMPTY_STATS;
    return {
      gamesPlayed: found.gamesPlayed ?? 0,
      gamesWon: found.gamesWon ?? 0,
      gamesWonFourPlayers: found.gamesWonFourPlayers ?? 0,
      gamesAbandoned: found.gamesAbandoned ?? 0,
      currentStreak: found.currentStreak ?? 0,
      maxStreak: found.maxStreak ?? 0,
    };
  }
}
