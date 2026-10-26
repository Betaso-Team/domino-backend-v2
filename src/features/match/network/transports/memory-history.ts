import { ObjectId } from "mongodb";
import {
  type ClosedRound,
  type HistoryEntry,
  type HistoryPort,
  type HistoryReader,
  MATCH_COUNT_CAP,
  MATCH_RECORD_VERSION,
  type MatchArchive,
  type MatchClosing,
  type MatchCursor,
  type MatchListPage,
  type MatchListQuery,
  type MatchOpening,
  type StoredMatchRecord,
} from "../history";
import {
  type HistoryAdapterOptions,
  LARGE_LAST,
  type ListedRow,
  entriesOf,
  largeLast,
  newestFirst,
  pageOf,
  storedClosingOf,
  storedEntryOf,
  storedOpeningOf,
  totalOf,
} from "./stored-record";

// Implementación de memoria. YA NO ES "la de antes de que haya base": el adaptador de Mongo
// existe (`./mongo-history.ts`) y el composition root elige entre los dos según haya o no
// `MONGO_URI`. Ésta es la implementación de producción de una instancia que elige NO
// persistir, y es la que usa la suite entera — que por eso no depende de ningún servicio
// externo. No es un doble y no se borra.
//
// GUARDA EL MISMO DOCUMENTO QUE MONGO, con las mismas reglas: la forma sale de `./stored-record.ts`
// —instantes como fechas incluidos— y el armado y el cierre son idempotentes igual que allá. Con una
// forma propia, la suite mediría un `/game-data` que producción no contesta.
//
// LO QUE SE PIERDE ELIGIÉNDOLA está acá abajo y es el argumento para configurar Mongo: tope
// de 200 partidas y muerte con el proceso, o sea una consola de soporte que solo ve lo que
// pasó desde el último deploy.
const MAX_MATCHES = 200;

type Stored = Record<string, unknown>;

export class MemoryHistory implements HistoryPort, HistoryReader, MatchArchive {
  private readonly byMatch = new Map<string, Stored>();
  private readonly now: () => Date;
  private readonly countCap: number;

  constructor(options: HistoryAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.countCap = options.countCap ?? MATCH_COUNT_CAP;
  }

  // El primer armado gana campo por campo, y una partida ya cerrada conserva su estado: es el
  // `$ifNull` del adaptador de Mongo escrito con el orden del spread —lo de la derecha gana—.
  open(matchId: string, opening: MatchOpening): void {
    this.write(matchId, (current, now) => ({
      ...born(matchId, current),
      ...storedOpeningOf(opening),
      status: "started",
      ...withoutLarge(current),
      ...stamps(current, now),
      ...onlyLarge(current),
    }));
  }

  record(entries: readonly HistoryEntry[]): void {
    // Todas las entradas de un lote son de la misma partida: las arma `MatchHistory`, que es por
    // partida.
    const matchId = entries[0]?.matchId;
    if (!matchId) return;
    this.write(matchId, (current, now) => {
      const timeline = (current?.timeline ?? []) as unknown[];
      return {
        ...born(matchId, current),
        ...current,
        ...stamps(current, now),
        timeline: [...timeline, ...entries.map(storedEntryOf)],
      };
    });
  }

  round(matchId: string, round: ClosedRound): void {
    this.write(matchId, (current, now) => {
      const rounds = (current?.rounds ?? []) as unknown[];
      return {
        ...born(matchId, current),
        ...current,
        ...stamps(current, now),
        rounds: [...rounds, round],
      };
    });
  }

  // El primer cierre gana: uno segundo devuelve el documento como estaba.
  close(matchId: string, closing: MatchClosing): void {
    this.write(matchId, (current, now) => {
      if (current && isClosed(current)) return current;
      return {
        ...born(matchId, current),
        ...withoutLarge(current),
        ...storedClosingOf(closing),
        ...stamps(current, now),
        ...onlyLarge(current),
      };
    });
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
    return Promise.resolve(entriesOf(this.byMatch.get(matchId)));
  }

  recordOf(matchId: string): Promise<StoredMatchRecord | undefined> {
    const document = this.byMatch.get(matchId);
    return Promise.resolve(document ? largeLast(document) : undefined);
  }

  snapshotOf(roomId: string): Promise<StoredMatchRecord | undefined> {
    const document =
      [...this.byMatch.values()].find((candidate) => candidate.roomId === roomId) ??
      this.byMatch.get(roomId);
    if (!document) return Promise.resolve(undefined);
    const { _id, ...rest } = document;
    return Promise.resolve(largeLast(rest));
  }

  // LAS MISMAS REGLAS QUE MONGO, recorriendo el `Map`: con 200 partidas como mucho, filtrar y ordenar
  // todo en cada pedido es lo que cuesta menos código y no cuesta nada más. El orden, la página y el
  // total salen de `./stored-record.ts`, compartidos con el adaptador de Mongo.
  async list(query: MatchListQuery): Promise<MatchListPage> {
    const rows: ListedRow[] = [...this.byMatch.values()]
      .filter((document) => matches(document, query))
      .map((document) => ({ id: String(document._id), document }))
      .sort(newestFirst);
    const total = await totalOf(query, this.countCap, {
      estimated: () => Promise.resolve(this.byMatch.size),
      upTo: (limit) => Promise.resolve(Math.min(rows.length, limit)),
    });
    const { after } = query;
    const page = after ? rows.filter((row) => isAfter(row, after)) : rows;
    return pageOf(page.slice(0, query.pageSize + 1), query.pageSize, total);
  }

  private write(matchId: string, next: (current: Stored | undefined, now: Date) => Stored): void {
    const current = this.byMatch.get(matchId);
    if (!current && this.byMatch.size >= MAX_MATCHES) {
      const oldest = this.byMatch.keys().next().value;
      if (oldest !== undefined) this.byMatch.delete(oldest);
    }
    this.byMatch.set(matchId, next(current, this.now()));
  }
}

// EL `_id` VA PRIMERO y ES un `ObjectId`, en texto: el panel lo muestra, lo usa de clave y filtra por
// él, y el listado desempata por él. Un `ObjectId` crece con cada uno que el proceso genera, así que a
// igual `createdAt` gana la última en nacer, como en Mongo; veinticuatro hex al azar desempatarían
// también, pero en un orden que ninguna base daría.
function born(matchId: string, current: Stored | undefined): Stored {
  return { _id: current?._id ?? new ObjectId().toHexString(), matchId };
}

function stamps(current: Stored | undefined, now: Date): Stored {
  return {
    version: current?.version ?? MATCH_RECORD_VERSION,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

function withoutLarge(current: Stored | undefined): Stored {
  if (!current) return {};
  const { rounds, timeline, entries, ...rest } = current;
  return rest;
}

function onlyLarge(current: Stored | undefined): Stored {
  return Object.fromEntries(
    LARGE_LAST.flatMap((key) => (current?.[key] === undefined ? [] : [[key, current[key]]])),
  );
}

const isClosed = (document: Stored) =>
  document.status === "finished" || document.status === "aborted";

// LOS FILTROS DEL LISTADO, con la semántica de la consulta de Mongo: un documento sin el campo no
// coincide con un filtro sobre él —sin `createdAt` no entra en un rango, sin sala no tiene sala—.
function matches(document: Stored, query: MatchListQuery): boolean {
  const at = document.createdAt instanceof Date ? document.createdAt.getTime() : undefined;
  if (query.from && (at === undefined || at < query.from.getTime())) return false;
  if (query.to && (at === undefined || at >= query.to.getTime())) return false;
  if (query.matchId !== undefined && document.matchId !== query.matchId) return false;
  if (query.roomId !== undefined && document.roomId !== query.roomId) return false;
  if (query.id !== undefined && document._id !== query.id) return false;
  if (query.userId !== undefined && !seatedIn(document, query.userId)) return false;
  return true;
}

// `{ "seats.userId": x }` de Mongo: alguno de los asientos, exacto. Sin `seats` —la forma vieja— no hay
// nadie sentado. Un usuario en dos asientos sigue siendo UN documento: esto es un `some`.
function seatedIn(document: Stored, userId: string): boolean {
  const seats = document.seats;
  return (
    Array.isArray(seats) &&
    seats.some((seat) => (seat as { userId?: unknown } | null)?.userId === userId)
  );
}

// ESTRICTAMENTE DESPUÉS del cursor, en el orden del listado.
function isAfter({ id, document }: ListedRow, cursor: MatchCursor): boolean {
  if (!(document.createdAt instanceof Date)) return false;
  const at = document.createdAt.getTime();
  const cursorAt = cursor.createdAt.getTime();
  return at < cursorAt || (at === cursorAt && id < cursor.id);
}
