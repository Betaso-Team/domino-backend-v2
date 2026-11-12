import { MemoryReactionUsage } from "./memory-reaction-usage";
import { reactionUsageContract } from "./tests/reaction-usage-contract";

// EL MISMO CONTRATO QUE EL ADAPTADOR DE MONGO (`./mongo-reaction-usage.int.test.ts`).
reactionUsageContract(() => {
  const store = new MemoryReactionUsage();
  return {
    store,
    reactions: async () => store.reactions(),
    muteChanges: async () => store.muteChanges(),
  };
});
