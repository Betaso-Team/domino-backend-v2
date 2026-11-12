import { Mongo } from "@/shared/mongo";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MuteChangeRecord, ReactionUsageRecord } from "../usage";
import {
  MongoReactionUsage,
  REACTION_EVENTS_COLLECTION,
  REACTION_MUTE_EVENTS_COLLECTION,
  type ReactionEventDocument,
  type ReactionMuteEventDocument,
} from "./mongo-reaction-usage";
import { muteChange, reaction, reactionUsageContract } from "./tests/reaction-usage-contract";

// EL CONTRATO CONTRA UN MONGO DE VERDAD: que el reenvío del silencio se descarte es el índice único, y
// eso es semántica de la base. Pide `MONGO_INT_URI` y se saltea sin ella (`src/tests/int-services.ts`).
let mongo: Mongo;
const reactions = () => mongo.collection<ReactionEventDocument>(REACTION_EVENTS_COLLECTION);
const mutes = () => mongo.collection<ReactionMuteEventDocument>(REACTION_MUTE_EVENTS_COLLECTION);

const reactionOf = (doc: ReactionEventDocument): ReactionUsageRecord => ({
  eventId: doc.id_evento,
  userId: doc.id_jugador,
  providerId: doc.id_proveedor,
  matchId: doc.id_partida,
  gameKind: doc.tipo_juego,
  reactionId: doc.id_reaccion,
  emoji: doc.codigo_emoji,
  at: doc.fecha_hora,
});

const muteOf = (doc: ReactionMuteEventDocument): MuteChangeRecord => ({
  eventId: doc.id_evento,
  userId: doc.id_jugador,
  providerId: doc.id_proveedor,
  muted: doc.accion === "silenciar",
  origin: doc.origen,
  matchId: doc.id_partida,
  at: doc.fecha_hora,
});

describe.skipIf(!MONGO_INT_URI)("MongoReactionUsage contra Mongo", () => {
  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  afterAll(async () => {
    await (await reactions()).drop().catch(() => {});
    await (await mutes()).drop().catch(() => {});
    await mongo.close();
  });

  const fresh = async () => {
    await (await reactions()).deleteMany({});
    await (await mutes()).deleteMany({});
    return new MongoReactionUsage(mongo, new MemoryLogger());
  };

  reactionUsageContract(async () => {
    const store = await fresh();
    return {
      store,
      reactions: async () =>
        (await (await reactions()).find({}, { sort: { _id: 1 } }).toArray()).map(reactionOf),
      muteChanges: async () =>
        (await (await mutes()).find({}, { sort: { _id: 1 } }).toArray()).map(muteOf),
    };
  });

  // LA FORMA EN LA BASE ES EL CONTRATO CON BI: los nombres de v1, campo por campo, y nada más.
  it("guarda los campos de v1, sin otros", async () => {
    const store = await fresh();
    await store.recordReaction(reaction({ gameKind: "torneo" }));
    await store.recordMuteChange(muteChange({ muted: false }));

    const { _id: a, ...gesture } = (await (await reactions()).findOne({})) ?? {};
    const { _id: b, ...mute } = (await (await mutes()).findOne({})) ?? {};
    expect(gesture).toEqual({
      id_evento: "7c0d8a52-3f43-4a54-9d7a-0d4f3c0f6a01",
      id_jugador: "u-ana",
      id_proveedor: "betaso",
      id_partida: "orq-1",
      tipo_juego: "torneo",
      id_reaccion: "fire",
      codigo_emoji: "🔥",
      fecha_hora: new Date("2026-11-12T12:00:00.000Z"),
    });
    expect(mute).toEqual({
      id_evento: "2b3c9a8e-6e8a-4a3f-8c51-5a4f1d2e7b02",
      id_jugador: "u-ana",
      id_proveedor: "betaso",
      accion: "reactivar",
      origen: "partida",
      id_partida: "orq-1",
      fecha_hora: new Date("2026-11-12T12:00:00.000Z"),
    });
  });

  it("crea el único de id_evento y los índices de fecha y jugador en las dos colecciones", async () => {
    const store = await fresh();
    await store.recordReaction(reaction());
    await store.recordMuteChange(muteChange());

    for (const collection of [await reactions(), await mutes()]) {
      const indexes = await collection.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "id_evento_1", key: { id_evento: 1 }, unique: true }),
          expect.objectContaining({ name: "fecha_hora_1", key: { fecha_hora: 1 } }),
          expect.objectContaining({ name: "id_jugador_1", key: { id_jugador: 1 } }),
        ]),
      );
    }
  });
});
