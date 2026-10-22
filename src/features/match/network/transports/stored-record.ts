import type {
  HistoryEntry,
  MatchClosing,
  MatchListPage,
  MatchListQuery,
  MatchOpening,
  MatchSummary,
  StoredMatchRecord,
} from "../history";

// LA FORMA GUARDADA, escrita UNA vez para los dos adaptadores. `MemoryHistory` no es un doble —es la
// implementación de la instancia sin Mongo y la que usa la suite—, así que tiene que guardar lo mismo
// que `MongoHistory`: con dos copias de estas conversiones, el endpoint que la suite mide contestaría
// una forma y producción otra.

// LOS INSTANTES SE GUARDAN COMO FECHAS (truco `7498991`). El motor cuenta en epoch ms, que nadie lee de
// un vistazo; una fecha BSON se lee como fecha en cualquier cliente, sale como ISO en el JSON y sigue
// ordenando y filtrando por rango. Las DURACIONES quedan números: son cantidades, no instantes.
const dateOf = (epochMs: number) => new Date(epochMs);

export const storedEntryOf = (entry: HistoryEntry) => ({ ...entry, at: dateOf(entry.at) });

export function storedOpeningOf(opening: MatchOpening): Record<string, unknown> {
  return { ...opening, matchStartedAt: dateOf(opening.matchStartedAt) };
}

export function storedClosingOf(closing: MatchClosing): Record<string, unknown> {
  const { matchStartedAt, matchEndedAt, players, betMultiplier, ...rest } = closing;
  return {
    ...rest,
    ...(matchStartedAt === undefined ? {} : { matchStartedAt: dateOf(matchStartedAt) }),
    matchEndedAt: dateOf(matchEndedAt),
    players: players.map(({ exit, ...player }) => ({
      ...player,
      ...(exit ? { exit: { ...exit, at: dateOf(exit.at) } } : {}),
    })),
    betMultiplier: {
      ...betMultiplier,
      proposals: betMultiplier.proposals.map(({ proposedAt, resolvedAt, ...proposal }) => ({
        ...proposal,
        proposedAt: dateOf(proposedAt),
        ...(resolvedAt === undefined ? {} : { resolvedAt: dateOf(resolvedAt) }),
      })),
    },
  };
}

/** Los campos grandes, que van AL FINAL del documento. `entries` es el nombre viejo de `timeline`. */
export const LARGE_LAST = ["rounds", "timeline", "entries"] as const;

/**
 * Los arreglos al final, en el orden en que el documento se haya escrito. Una lectura truncada pierde
 * el final del documento, y el final tiene que ser la parte grande y no el desenlace: una partida que
 * nunca cerró —o uno de la forma vieja— todavía los tiene en el medio.
 */
export function largeLast(document: StoredMatchRecord): StoredMatchRecord {
  const { rounds, timeline, entries, ...rest } = document;
  return {
    ...rest,
    ...(rounds === undefined ? {} : { rounds }),
    ...(timeline === undefined ? {} : { timeline }),
    ...(entries === undefined ? {} : { entries }),
  };
}

/**
 * LA SECUENCIA DE CUALQUIER FORMA, con los instantes de vuelta en epoch ms: `timeline` y, si no está,
 * la `entries` de los documentos viejos —que guardaban el `at` como número—. Es lo que leen el
 * endpoint de soporte y el replay, que usa el `at` como reloj.
 */
export function entriesOf(document: StoredMatchRecord | undefined | null): HistoryEntry[] {
  const stored = (document?.timeline ?? document?.entries ?? []) as readonly Record<
    string,
    unknown
  >[];
  return stored.map((entry) => {
    const at = entry.at;
    return { ...entry, at: at instanceof Date ? at.getTime() : at } as unknown as HistoryEntry;
  });
}

/** Lo que el listado proyecta de cada documento. Es la lista que el adaptador de Mongo le pide a la base. */
export const SUMMARY_FIELDS = [
  "matchId",
  "roomId",
  "status",
  "table",
  "createdAt",
  "updatedAt",
  "matchStartedAt",
  "matchEndedAt",
  "matchEndReason",
  "winnerIds",
] as const;

/** Una fila del listado: el `_id` como texto, el juego, y sólo los campos que el documento tenga. */
export function summaryOf(id: string, document: StoredMatchRecord): MatchSummary {
  const present = SUMMARY_FIELDS.filter((field) => document[field] !== undefined).map(
    (field) => [field, document[field]] as const,
  );
  const { matchId, roomId, ...rest } = Object.fromEntries(present) as Omit<
    MatchSummary,
    "_id" | "game"
  >;
  return {
    _id: id,
    matchId,
    ...(roomId === undefined ? {} : { roomId }),
    game: "domino",
    ...rest,
  };
}

/** Lo que los dos adaptadores aceptan de afuera, para la suite. */
export interface HistoryAdapterOptions {
  /** El instante de cada escritura (`createdAt`/`updatedAt`). Default: el reloj del sistema. */
  readonly now?: () => Date;
  /** Hasta cuánto se cuenta un listado filtrado. Default: `MATCH_COUNT_CAP`. */
  readonly countCap?: number;
}

// ── EL LISTADO, lo que los dos adaptadores deciden igual ─────────────────────────────────────────

/** Una fila de la página antes de proyectarla: su `_id` como texto y el documento. */
export interface ListedRow {
  readonly id: string;
  readonly document: StoredMatchRecord;
}

/** ¿Pidió algún filtro? El tamaño de página y el cursor no cuentan: no achican lo que hay. */
export const isFiltered = (query: MatchListQuery): boolean =>
  query.from !== undefined ||
  query.to !== undefined ||
  query.matchId !== undefined ||
  query.roomId !== undefined ||
  query.id !== undefined;

const createdAtOf = (document: StoredMatchRecord): number | undefined =>
  document.createdAt instanceof Date ? document.createdAt.getTime() : undefined;

/**
 * EL ORDEN DEL LISTADO: `createdAt` descendente y, en el mismo milisegundo, el `_id` descendente. Los
 * `_id` son veinticuatro hex en minúscula, así que comparar el texto es comparar los doce bytes del
 * `ObjectId`, que es como los compara Mongo. Un documento sin `createdAt` va al final, como en Mongo.
 */
export function newestFirst(a: ListedRow, b: ListedRow): number {
  const at = createdAtOf(a.document) ?? Number.NEGATIVE_INFINITY;
  const bt = createdAtOf(b.document) ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return bt - at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * LA PÁGINA, de las filas ya ordenadas: se piden `pageSize + 1` y la de más sólo dice que hay otra.
 * El cursor es la última fila que SE MUESTRA, no la de más: la siguiente página empieza después de ella.
 *
 * Una última fila sin `createdAt` no puede ser cursor —no hay instante del que seguir— y corta el
 * recorrido. No pasa: todo escritor pone `createdAt` al nacer el documento, la forma vieja incluida.
 */
export function pageOf(
  rows: readonly ListedRow[],
  pageSize: number,
  total: Pick<MatchListPage, "total" | "totalExact">,
): MatchListPage {
  const shown = [...rows].sort(newestFirst).slice(0, pageSize);
  const last = shown.at(-1);
  const lastAt = last ? createdAtOf(last.document) : undefined;
  return {
    items: shown.map(({ id, document }) => summaryOf(id, document)),
    ...(rows.length > pageSize && last && lastAt !== undefined
      ? { next: { createdAt: new Date(lastAt), id: last.id } }
      : {}),
    ...total,
  };
}

/**
 * EL TOTAL, con las tres reglas de `MatchListPage`. Se cuenta hasta el tope MÁS UNO: es lo que separa
 * "exactamente el tope" de "más que el tope" sin contar el resto.
 */
export async function totalOf(
  query: MatchListQuery,
  cap: number,
  count: {
    readonly estimated: () => Promise<number>;
    readonly upTo: (limit: number) => Promise<number>;
  },
): Promise<Pick<MatchListPage, "total" | "totalExact">> {
  if (query.after) return { total: null, totalExact: false };
  if (!isFiltered(query)) return { total: await count.estimated(), totalExact: false };
  const counted = await count.upTo(cap + 1);
  return counted > cap ? { total: cap, totalExact: false } : { total: counted, totalExact: true };
}
