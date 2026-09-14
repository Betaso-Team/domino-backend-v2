import type { HistoryEntry, HistoryPort, HistoryReader } from "../history.js";

// Implementación de memoria. El adaptador de Mongo llega con la persistencia;
// esto es lo que permite que el mecanismo entero —envoltura, seq, intercalado—
// esté probado antes de que haya base.
const MAX_MATCHES = 200;

export class MemoryHistory implements HistoryPort, HistoryReader {
  private readonly byMatch = new Map<string, HistoryEntry[]>();

  record(entries: readonly HistoryEntry[]): void {
    for (const entry of entries) {
      const existing = this.byMatch.get(entry.matchId);
      if (existing) {
        existing.push(entry);
        continue;
      }
      if (this.byMatch.size >= MAX_MATCHES) {
        const oldest = this.byMatch.keys().next().value;
        if (oldest !== undefined) this.byMatch.delete(oldest);
      }
      this.byMatch.set(entry.matchId, [entry]);
    }
  }

  /** `HistoryReader`: para tests y para la consola de soporte. No es API de producto. */
  of(matchId: string): readonly HistoryEntry[] {
    return this.byMatch.get(matchId) ?? [];
  }
}
