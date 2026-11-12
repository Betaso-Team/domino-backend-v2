import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { MongoReactionUsage } from "./mongo-reaction-usage";
import { muteChange, reaction } from "./tests/reaction-usage-contract";

// LO QUE NO PIDE UN MONGO DE VERDAD: que un fallo no salga del adaptador. El resto del contrato corre
// contra la base en `./mongo-reaction-usage.int.test.ts`.
describe("MongoReactionUsage sin base", () => {
  it("con la base caída no rechaza: lo deja en el log a nivel error y la mesa sigue", async () => {
    const logger = new MemoryLogger();
    const broken = new MongoReactionUsage(
      { collection: () => Promise.reject(new Error("mongo caído")) },
      logger,
    );

    await expect(broken.recordReaction(reaction())).resolves.toBeUndefined();
    await expect(broken.recordMuteChange(muteChange())).resolves.toBeUndefined();
    expect(logger.at_("error")).toHaveLength(2);
  });
});
