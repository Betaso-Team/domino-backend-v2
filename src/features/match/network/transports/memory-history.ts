import type { HistoryEntry, HistoryPort, HistoryReader } from "../history";
import {
  type MatchRow,
  type MatchSummary,
  type MatchSummaryPort,
  type Paginated,
  type PlayerLog,
  type PlayerStats,
  rowFor,
  statsFor,
} from "../player-log";

// Implementación de memoria. YA NO ES "la de antes de que haya base": el adaptador de Mongo
// existe (`./mongo-history.ts`) y el composition root elige entre los dos según haya o no
// `MONGO_URI`. Ésta es la implementación de producción de una instancia que elige NO
// persistir, y es la que usa la suite entera — que por eso no depende de ningún servicio
// externo. No es un doble y no se borra.
//
// LO QUE SE PIERDE ELIGIÉNDOLA está acá abajo y es el argumento para configurar Mongo: tope
// de 200 partidas y muerte con el proceso, o sea una consola de soporte que solo ve lo que
// pasó desde el último deploy.
const MAX_MATCHES = 200;

export class MemoryHistory implements HistoryPort, HistoryReader, MatchSummaryPort, PlayerLog {
  private readonly byMatch = new Map<string, HistoryEntry[]>();
  private readonly summaries = new Map<string, MatchSummary>();

  summarize(summary: MatchSummary): void {
    this.summaries.set(summary.matchId, summary);
  }

  pageOf(playerId: string, page: number, perPage: number): Promise<Paginated<MatchRow>> {
    const all = [...this.summaries.values()]
      .filter((match) => [...match.players, ...match.quitPlayers].some(({ id }) => id === playerId))
      .sort((a, b) => b.playedAt.getTime() - a.playedAt.getTime());
    const totalItems = all.length;
    const totalPages = Math.ceil(totalItems / perPage);
    const items = all
      .slice((page - 1) * perPage, page * perPage)
      .map((match) => rowFor(playerId, match));
    return Promise.resolve({
      items,
      page,
      perPage,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    });
  }

  statsOf(playerId: string): Promise<PlayerStats> {
    return Promise.resolve(statsFor(playerId, [...this.summaries.values()]));
  }

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
   * NO HAY NADA QUE DRENAR, y eso no es un stub: escribir acá es asignar en un `Map`, o sea
   * que cuando `record` vuelve ya terminó. La implementación vacía es la respuesta VERDADERA
   * de esta implementación, no un hueco — la que tiene algo que esperar es la de Mongo.
   *
   * Se escribe con la promesa ya resuelta y no como `async`, por el mismo motivo que `of` de
   * más abajo: un `async` sin un solo `await` adentro invita a leer una espera que no existe.
   */
  drain(): Promise<void> {
    return Promise.resolve();
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
