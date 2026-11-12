import type { MuteChangeRecord, ReactionUsageRecord, ReactionUsageStore } from "../usage";

// EL REGISTRO DE USO EN MEMORIA, cuando no hay `MONGO_URI` (local, la suite). No es un doble: cumple el
// mismo contrato que el de Mongo (`./tests/reaction-usage-contract.ts`), incluido ignorar un cambio de
// silencio repetido. Se pierde con el proceso, que es lo que se acepta sin base.
export class MemoryReactionUsage implements ReactionUsageStore {
  private readonly reactionRows: ReactionUsageRecord[] = [];
  private readonly muteRows = new Map<string, MuteChangeRecord>();

  async recordReaction(record: ReactionUsageRecord): Promise<void> {
    this.reactionRows.push(record);
  }

  async recordMuteChange(record: MuteChangeRecord): Promise<void> {
    if (!this.muteRows.has(record.eventId)) this.muteRows.set(record.eventId, record);
  }

  /** Lo guardado, en el orden en que entró. Para la suite. */
  reactions(): readonly ReactionUsageRecord[] {
    return [...this.reactionRows];
  }

  muteChanges(): readonly MuteChangeRecord[] {
    return [...this.muteRows.values()];
  }
}
