import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { MemoryReactionUsage } from "../transports/memory-reaction-usage";
import { ReactionUsageLog } from "../usage";

const AT = new Date("2026-11-12T12:00:00.000Z");

const build = () => {
  const store = new MemoryReactionUsage();
  const logger = new MemoryLogger();
  let ids = 0;
  const usage = new ReactionUsageLog({
    store,
    table: {
      matchId: "orq-1",
      gameKind: "gratuita",
      seats: new Map([
        ["seat-1", { userId: "u-ana", providerId: "betaso" }],
        ["seat-2", { userId: "u-beto", providerId: "parley" }],
      ]),
    },
    now: () => AT,
    newEventId: () => `ev-${++ids}`,
    log: logger,
  });
  return { store, usage, logger };
};

describe("ReactionUsageLog", () => {
  // El `seat-N` no le dice nada a BI: la fila lleva al jugador de Tablea, su proveedor y la mesa.
  it("un gesto sale con el jugador, su proveedor, la mesa y un id propio", () => {
    const { store, usage } = build();

    usage.reactionRelayed({
      fromPlayerId: "seat-2",
      reaction: { id: "fire", type: "emoji", content: "🔥" },
    });

    expect(store.reactions()).toEqual([
      {
        eventId: "ev-1",
        userId: "u-beto",
        providerId: "parley",
        matchId: "orq-1",
        gameKind: "gratuita",
        reactionId: "fire",
        emoji: "🔥",
        at: AT,
      },
    ]);
  });

  it("un cambio de silencio lleva el id del cliente y el origen `partida`", async () => {
    const { store, usage } = build();

    await usage.muteChanged("seat-1", { muted: true, eventId: "cliente-1" });

    expect(store.muteChanges()).toEqual([
      {
        eventId: "cliente-1",
        userId: "u-ana",
        providerId: "betaso",
        muted: true,
        origin: "partida",
        matchId: "orq-1",
        at: AT,
      },
    ]);
  });

  it("un asiento que la mesa no conoce no se registra, no lanza y queda en el log", async () => {
    const { store, usage, logger } = build();

    usage.reactionRelayed({
      fromPlayerId: "seat-9",
      reaction: { id: "fire", type: "emoji", content: "🔥" },
    });
    await usage.muteChanged("seat-9", { muted: false, eventId: "cliente-2" });

    expect(store.reactions()).toEqual([]);
    expect(store.muteChanges()).toEqual([]);
    expect(logger.at_("warn")).toHaveLength(2);
  });
});
