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

  /**
   * `HistoryReader`: para tests y para la consola de soporte. No es API de producto.
   *
   * El cuerpo es SINCRÓNICO y la promesa se arma ya resuelta —no es un método `async`—
   * a propósito: acá no hay nada que esperar, y escribirlo así deja a la vista que el
   * `Promise` lo pide el PUERTO (por el adaptador de Mongo, que sí consulta) y no esta
   * implementación. Un `async` sin un solo `await` adentro invita a leer una latencia
   * que no existe, y a buscar una carrera acá cuando un test lee de más o de menos.
   */
  of(matchId: string): Promise<readonly HistoryEntry[]> {
    return Promise.resolve(this.byMatch.get(matchId) ?? []);
  }
}
