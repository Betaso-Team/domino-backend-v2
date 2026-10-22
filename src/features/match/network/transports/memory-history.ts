import { randomBytes } from "node:crypto";
import {
  type ClosedRound,
  type HistoryEntry,
  type HistoryPort,
  type HistoryReader,
  MATCH_RECORD_VERSION,
  type MatchArchive,
  type MatchClosing,
  type MatchOpening,
  type MatchPage,
  type StoredMatchRecord,
} from "../history";
import {
  LARGE_LAST,
  entriesOf,
  largeLast,
  storedClosingOf,
  storedEntryOf,
  storedOpeningOf,
  summaryOf,
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

  // LA MÁS NUEVA PRIMERO, y a igual `createdAt` la última en llegar: es el `_id` descendente con que
  // desempata el adaptador de Mongo.
  page(page: number, pageSize: number): Promise<MatchPage> {
    const ordered = [...this.byMatch.values()]
      .reverse()
      .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
    const items = ordered
      .slice((page - 1) * pageSize, page * pageSize)
      .map((document) => summaryOf(String(document._id), document));
    return Promise.resolve({ items, total: ordered.length });
  }

  private write(matchId: string, next: (current: Stored | undefined, now: Date) => Stored): void {
    const current = this.byMatch.get(matchId);
    if (!current && this.byMatch.size >= MAX_MATCHES) {
      const oldest = this.byMatch.keys().next().value;
      if (oldest !== undefined) this.byMatch.delete(oldest);
    }
    this.byMatch.set(matchId, next(current, new Date()));
  }
}

// EL `_id` VA PRIMERO y es opaco: veinticuatro hex, como el `ObjectId` que Mongo pondría. El panel lo
// muestra y lo usa de clave; no lo interpreta.
function born(matchId: string, current: Stored | undefined): Stored {
  return { _id: current?._id ?? randomBytes(12).toString("hex"), matchId };
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

const timeOf = (value: unknown) => (value instanceof Date ? value.getTime() : 0);
