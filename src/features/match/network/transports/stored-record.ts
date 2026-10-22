import type {
  HistoryEntry,
  MatchClosing,
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
