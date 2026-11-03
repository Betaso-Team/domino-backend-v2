import { Mongo } from "@/shared/mongo";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, describe } from "vitest";
import { MongoPlayerStats, PLAYER_STATS_COLLECTION } from "./mongo-player-stats";
import { playerStatsContract } from "./tests/player-stats-contract";

// EL CONTRATO CONTRA UN MONGO DE VERDAD: que el pipeline sea atómico y que el duplicado sea E11000 es
// semántica de la base. Pide `MONGO_INT_URI` y se saltea sin ella (`src/tests/int-services.ts`).
let mongo: Mongo;
const collection = () => mongo.collection(PLAYER_STATS_COLLECTION);

describe.skipIf(!MONGO_INT_URI)("MongoPlayerStats contra Mongo", () => {
  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  afterAll(async () => {
    await (await collection()).drop().catch(() => {});
    await mongo.close();
  });

  playerStatsContract(async () => {
    await (await collection()).deleteMany({});
    return new MongoPlayerStats(mongo, new MemoryLogger());
  });
});
