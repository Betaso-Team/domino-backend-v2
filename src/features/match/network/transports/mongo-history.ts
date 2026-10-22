import type { Logger } from "@/logger";
import {
  type Collection,
  type CountDocumentsOptions,
  type Document,
  type Filter,
  type FindOptions,
  type IndexDescription,
  MongoServerError,
  ObjectId,
} from "mongodb";
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
  MatchListTimeoutError,
  type MatchOpening,
  type StoredMatchRecord,
} from "../history";
import {
  type HistoryAdapterOptions,
  LARGE_LAST,
  SUMMARY_FIELDS,
  entriesOf,
  largeLast,
  pageOf,
  storedClosingOf,
  storedEntryOf,
  storedOpeningOf,
  totalOf,
} from "./stored-record";

// EL HISTORIAL QUE SOBREVIVE AL REINICIO. `MemoryHistory` tiene tope de 200 partidas y muere
// con el proceso, así que el endpoint interno de soporte y el CLI de replay —los dos ya
// construidos— no tenían nada que mostrar de ayer. Ésta es la brecha que cierra.
//
// **Un documento por PARTIDA**, el registro v2.1 (ver `../history.ts`): la cabecera al arrancar, la
// timeline y las manos empujadas en lotes, y el desenlace al cerrar. Una partida de dominó deja del
// orden de cien a doscientas entradas, así que el techo de 16 MB por documento ni se acerca.

// LA COLECCIÓN, en una constante y NO en una variable de entorno, que es la primera de las
// tres cosas que el dominó decide distinto que truco. Allá el nombre se configura porque se
// escribe en colecciones de v1, cuyos nombres mongoose los pluraliza implícitamente y hay que
// adivinarlos. Acá el dominó es el ÚNICO escritor de esta colección: un nombre configurable
// sería un valor que nadie cambia y que se puede escribir mal, y su contramedida —contar los
// documentos al arrancar, el `announce()` de truco— sería una pieza entera existiendo para
// cubrir un riesgo que se elige no tener.
//
// El valor no es nuevo: `replay.ts` ya nombraba `match_history` en prosa antes de que la
// persistencia existiera.
export const HISTORY_COLLECTION = "match_history";

// LO MÍNIMO QUE ESTE ADAPTADOR NECESITA de la conexión, declarado como interfaz y no usando
// la clase `Mongo` concreta. `Mongo` la satisface estructuralmente, así que el cableado no
// cambia; lo que se gana es que la suite pueda darle un doble SIN un `as unknown as Mongo`,
// que es el cast que esta feature ya decidió no tener (ver el comentario de `HistoryReader`
// en ../history.ts: un cast es una mentira que tsc no puede ver).
//
// Se corta acá y no más abajo a propósito: `Collection<T>` sigue siendo el tipo del driver,
// que es lo que hace que tsc verifique el documento de update. Narrar a mano una interfaz
// con `updateOne`/`findOne` habría aflojado justamente lo único que el gate puede chequear.
export interface HistoryStore {
  collection<T extends Document>(name: string): Promise<Collection<T>>;
}

/** Una entrada como queda guardada: el instante como fecha. */
export type StoredEntry = Omit<HistoryEntry, "at"> & { readonly at: Date };

// LA FORMA DEL DOCUMENTO, declarada en lo que los operadores CLÁSICOS escriben: es lo que hace que el
// `$push` y el `$setOnInsert` tipen sin castear. La cabecera y el cierre van por pipeline
// (`$replaceWith`), que el driver tipa como `Document[]`, y por eso no están acá. Un `type` y no una
// `interface` para que un documento leído sea un `StoredMatchRecord` sin cast.
//
// `createdAt`/`updatedAt` no son campos derivados de la timeline aunque lo parezcan: `entry.at` sale
// del `Clock` INYECTADO —que el replay y la suite reemplazan— y estos dos son el instante real de la
// escritura. `createdAt` es además el orden del listado del panel.
export type MatchHistoryDocument = {
  matchId: string;
  // Opcional: la forma vieja no la guardaba. Se declara por el filtro del listado.
  roomId?: string;
  // Opcional: los documentos de antes de la v2.1 no la llevan.
  version?: number;
  createdAt: Date;
  updatedAt: Date;
  timeline?: StoredEntry[];
  rounds?: ClosedRound[];
  /** La forma vieja, anterior a la v2.1: sólo se lee. */
  entries?: HistoryEntry[];
};

// LOS TRES ÍNDICES DEL REGISTRO, nombrados por lo mismo que los del catálogo: `createIndexes` es
// idempotente mientras nombre y clave coincidan. CADA FORMA DEL LISTADO SALE DE UNO, sin recorrer la
// colección ni ordenar en memoria (medido con `explain` contra un Mongo de verdad en
// `./mongo-history.int.test.ts`, forma por forma):
//
//   · `matchId` ÚNICO: el documento no puede nacer dos veces (truco `8d4001a`). La cola de abajo lo
//     garantiza en el proceso; el índice lo garantiza en la base. Sirve también el filtro `matchId`.
//   · `roomId` con el orden del listado detrás: lo que pregunta `/game-data/:roomId` —por el prefijo— y
//     el filtro por sala, con o sin fechas, ya ordenado. Era `roomId_1` a secas, y con él la página de
//     una sala salía con una etapa SORT en memoria (medido): el índice traía las filas de la sala y el
//     orden se hacía después.
//   · `createdAt` DESCENDENTE con el `_id` de desempate: el orden exacto del listado, así que la página
//     sin filtros, la de un rango de fechas y la de un cursor salen del índice ya ordenadas.
//
// El filtro por `_id` no necesita uno: el de la colección ya está.
//
// EN DOS PEDIDOS Y NO EN UNO, porque `createIndexes` es todo o nada (medido contra Mongo 7): con dos
// documentos viejos de la misma partida el único falla, y en el mismo pedido se llevaba a los otros
// dos con él — el listado quedaba recorriendo la colección entera hasta que alguien limpiara las filas.
const HISTORY_INDEXES: readonly IndexDescription[][] = [
  [{ key: { matchId: 1 }, name: "matchId_1", unique: true }],
  [
    { key: { roomId: 1, createdAt: -1, _id: -1 }, name: "roomId_1_createdAt_-1__id_-1" },
    { key: { createdAt: -1, _id: -1 }, name: "createdAt_-1__id_-1" },
  ],
];

const NEWEST_FIRST = { createdAt: -1, _id: -1 } as const;

// EL PLAZO DE CADA CONSULTA DEL LISTADO. Todas tienen un índice detrás y contestan en milisegundos; el
// plazo es para la que no —un índice que falta, una base saturada—, que sin él quedaría colgada con el
// panel esperando. Vencerlo es `MatchListTimeoutError`, y la ruta lo contesta como 503.
export const LIST_MAX_TIME_MS = 5_000;

const SUMMARY_PROJECTION = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, 1]));

type ListFilter = Filter<MatchHistoryDocument>;

/** Los filtros pedidos, con AND. Sin cursor: es lo que se cuenta. */
function filterOf(query: MatchListQuery): ListFilter {
  const createdAt = {
    ...(query.from ? { $gte: query.from } : {}),
    ...(query.to ? { $lt: query.to } : {}),
  };
  return {
    ...(query.from || query.to ? { createdAt } : {}),
    ...(query.matchId === undefined ? {} : { matchId: query.matchId }),
    ...(query.roomId === undefined ? {} : { roomId: query.roomId }),
    ...(query.id === undefined ? {} : { _id: new ObjectId(query.id) }),
  };
}

// ESTRICTAMENTE DESPUÉS DEL CURSOR: `createdAt < c OR (createdAt = c AND _id < id)`, con los filtros
// REPETIDOS EN CADA RAMA del `$or` y no al lado. Lo decidió el `explain`: con el `$or` a la par de los
// filtros, el planificador recorre el índice desde el cursor y descarta en el FETCH las filas del mismo
// milisegundo ya mostradas —un documento leído de más por página, más uno por cada empate—; con el
// `$or` en la raíz planifica cada rama por separado y las une ya ordenadas (`SORT_MERGE`, que no
// bloquea), así que lee exactamente las filas que devuelve.
function afterOf(filter: ListFilter, cursor: MatchCursor): ListFilter {
  const { createdAt, _id, ...rest } = filter as Record<string, unknown> & {
    createdAt?: Record<string, Date>;
    _id?: ObjectId;
  };
  const last = new ObjectId(cursor.id);
  return {
    $or: [
      { ...rest, ...(_id ? { _id } : {}), createdAt: { ...createdAt, $lt: cursor.createdAt } },
      {
        ...rest,
        createdAt: { ...createdAt, $eq: cursor.createdAt },
        _id: _id ? { $eq: _id, $lt: last } : { $lt: last },
      },
    ],
  } as ListFilter;
}

/**
 * LA CONSULTA EXACTA DE UNA PÁGINA, exportada para que el `explain` de la suite mida la que corre y no
 * una copia. Se pide una fila de más: es la que dice si hay otra página.
 *
 * CON `matchId` O `id` NO SE ORDENA EN LA BASE: los dos son únicos, así que la página tiene como mucho
 * una fila, y pedirle a Mongo que ordene una fila le agrega una etapa SORT sobre el índice único
 * (medido). El orden lo pone igual `pageOf`, por si el índice único no se pudo crear y hay dos.
 */
export function pageQueryOf(query: MatchListQuery): {
  readonly filter: ListFilter;
  readonly options: FindOptions;
} {
  const filter = filterOf(query);
  const unique = query.matchId !== undefined || query.id !== undefined;
  return {
    filter: query.after ? afterOf(filter, query.after) : filter,
    options: {
      projection: SUMMARY_PROJECTION,
      ...(unique ? {} : { sort: NEWEST_FIRST }),
      limit: query.pageSize + 1,
      maxTimeMS: LIST_MAX_TIME_MS,
    },
  };
}

/** La consulta exacta del total filtrado, hasta `limit`. */
export function countQueryOf(
  query: MatchListQuery,
  limit: number,
): { readonly filter: ListFilter; readonly options: CountDocumentsOptions } {
  return { filter: filterOf(query), options: { limit, maxTimeMS: LIST_MAX_TIME_MS } };
}

// `MaxTimeMSExpired`: la base cortó la consulta por el plazo.
const isTimeout = (error: unknown) =>
  error instanceof MongoServerError && (error.code === 50 || error.codeName === "MaxTimeMSExpired");

// LO QUE EL DOCUMENTO TIENE MENOS SUS ARREGLOS, y los arreglos aparte: las dos mitades con que la
// cabecera y el cierre reescriben el documento dejando lo grande AL FINAL. Mongo guarda los campos en
// el orden en que nacieron y la timeline nace con la primera entrada —a veces antes que la cabecera,
// con una caída durante el sentado—, así que sin esto el desenlace quedaría detrás de lo grande y
// sería lo primero que pierde una lectura truncada.
const WITHOUT_LARGE = {
  $arrayToObject: {
    $filter: {
      input: { $objectToArray: "$$ROOT" },
      cond: { $not: { $in: ["$$this.k", [...LARGE_LAST]] } },
    },
  },
};
// Un campo ausente queda afuera del objeto, así que una partida sin manos no gana un `rounds` vacío.
const ONLY_LARGE = Object.fromEntries(LARGE_LAST.map((key) => [key, `$${key}`]));

const stampsAt = (now: Date) => ({
  version: { $ifNull: ["$version", MATCH_RECORD_VERSION] },
  createdAt: { $ifNull: ["$createdAt", now] },
  updatedAt: now,
});

export class MongoHistory implements HistoryPort, HistoryReader, MatchArchive {
  // UNA ESCRITURA A LA VEZ POR PARTIDA. Cada verbo es fire-and-forget, así que sin esto llegan a la
  // base a la vez — y dos upserts que no encuentran el documento INSERTAN uno cada uno, partiendo la
  // partida en dos filas. Fija también el ORDEN de las escrituras, que es cómo se leen los arreglos.
  // Por proceso alcanza: una partida vive en una sala, y una sala en un proceso.
  private readonly writing = new Map<string, Promise<void>>();
  // LOS LOTES QUE TODAVÍA ESTÁN VIAJANDO. Es lo único que hace falta para que el apagado
  // pueda esperarlos, y es un `Set` y no un contador porque lo que se espera son las
  // promesas mismas.
  //
  // No crece sin control: cada entrada se borra cuando su escritura termina, bien o mal. En
  // régimen tiene el tamaño de la concurrencia real —una escritura por lote en vuelo—, no
  // el del historial.
  private readonly inFlight = new Set<Promise<void>>();
  // LA COLECCIÓN YA PREPARADA, con los índices pedidos una vez por proceso (el criterio del catálogo).
  private prepared?: Promise<Collection<MatchHistoryDocument>>;

  private readonly now: () => Date;
  private readonly countCap: number;

  constructor(
    private readonly store: HistoryStore,
    private readonly logger: Logger,
    options: HistoryAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.countCap = options.countCap ?? MATCH_COUNT_CAP;
  }

  // EL PRIMER ARMADO GANA, campo por campo: el documento existente va DESPUÉS de la cabecera en el
  // `$mergeObjects`, así que lo que ya está se queda —una partida cerrada no vuelve a `started`— y lo
  // que falta se completa.
  open(matchId: string, opening: MatchOpening): void {
    const now = this.now();
    this.write(matchId, "no se pudo grabar el inicio", {}, (collection) =>
      collection.updateOne(
        { matchId },
        [
          {
            $replaceWith: {
              $mergeObjects: [
                { matchId: { $literal: matchId } },
                // `$literal`: un nombre visible que empiece con `$` se leería como un campo.
                { $literal: { ...storedOpeningOf(opening), status: "started" } },
                WITHOUT_LARGE,
                stampsAt(now),
                ONLY_LARGE,
              ],
            },
          },
        ],
        { upsert: true },
      ),
    );
  }

  // `void` POR CONTRATO, y acá es donde se cobra: lo llaman el camino de un comando y el de
  // un timer, y ninguno espera. Que la base falle no puede frenar una partida — lo único que
  // se le debe al operador es enterarse. Por eso el `catch` solo loguea.
  //
  // Devolver la promesa "por si alguien quiere esperarla" rompería el contrato de a poco:
  // el primer llamador que le ponga `await` mete la latencia de Mongo dentro del manejo de
  // un mensaje del socket, que es el camino sincrónico que `architecture.test.ts` protege.
  record(entries: readonly HistoryEntry[]): void {
    if (entries.length === 0) return;
    // Todas las entradas de un lote son de la misma partida: las arma `MatchHistory`, que es
    // por partida. Se lee del primero en vez de agrupar porque agrupar sería código para un
    // caso que la clase de arriba no puede producir.
    const matchId = entries[0]?.matchId;
    if (!matchId) return;
    const now = this.now();
    this.write(matchId, "no se pudo grabar el lote", { entries: entries.length }, (collection) =>
      collection.updateOne(
        { matchId },
        {
          // `$push` con `$each` y NUNCA `$set` sobre la timeline: cada lote se agrega al final,
          // que es lo que hace que el `seq` siga siendo el orden. Con `$set` el documento
          // quedaría con el último lote y el historial sería siempre la última jugada.
          $push: { timeline: { $each: entries.map(storedEntryOf) } },
          $set: { updatedAt: now },
          // La cabecera de la FILA se escribe UNA SOLA VEZ, con la primera escritura. `$setOnInsert`
          // y no `$set` porque describe el nacimiento del documento: con `$set`, `createdAt`
          // avanzaría con cada jugada y dejaría de ser el instante en que la partida empezó a
          // grabarse.
          $setOnInsert: { matchId, version: MATCH_RECORD_VERSION, createdAt: now },
        },
        { upsert: true },
      ),
    );
  }

  round(matchId: string, round: ClosedRound): void {
    const now = this.now();
    this.write(matchId, "no se pudo grabar la mano", { roundNumber: round.roundNumber }, (c) =>
      c.updateOne(
        { matchId },
        {
          $push: { rounds: round },
          $set: { updatedAt: now },
          $setOnInsert: { matchId, version: MATCH_RECORD_VERSION, createdAt: now },
        },
        { upsert: true },
      ),
    );
  }

  /**
   * Escribe el desenlace y deja `rounds` y `timeline` AL FINAL del documento. EL PRIMER CIERRE GANA:
   * sobre un documento ya cerrado el pipeline devuelve `$$ROOT` tal cual.
   */
  close(matchId: string, closing: MatchClosing): void {
    const now = this.now();
    this.write(matchId, "no se pudo grabar el cierre", { status: closing.status }, (collection) =>
      collection.updateOne(
        { matchId },
        [
          {
            $replaceWith: {
              // La forma de ARREGLO del `$cond` —si, entonces, si no—: la de objeto lleva una clave
              // `then`, y un objeto con `then` es un thenable para quien lo `await`-e.
              $cond: [
                { $in: [{ $ifNull: ["$status", null] }, ["finished", "aborted"]] },
                "$$ROOT",
                {
                  $mergeObjects: [
                    { matchId: { $literal: matchId } },
                    WITHOUT_LARGE,
                    { $literal: storedClosingOf(closing) },
                    stampsAt(now),
                    ONLY_LARGE,
                  ],
                },
              ],
            },
          },
        ],
        { upsert: true },
      ),
    );
  }

  // Ver el comentario de `HistoryPort.drain`. EN BUCLE y no una sola pasada: nada impide que
  // un lote que estaba en vuelo dispare otro —el `finally` que limpia el `Set` corre después
  // de que la promesa resuelve—, y un drenado que espera una sola tanda dejaría justo al
  // último afuera. Termina porque durante el apagado ya no hay salas que graben: la sala se
  // dispone ANTES de que esto corra (§`src/main.ts`).
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      // `all` y no `allSettled` porque ninguna de estas promesas puede rechazar: son las que
      // salieron del `catch` de `write`.
      await Promise.all([...this.inFlight]);
    }
  }

  // Vacío y no un fallo cuando no hay documento: sus dos llamadores ya distinguen ese caso
  // —el endpoint interno responde 404, el CLI corta con "no hay historial"— y una partida
  // que no existe no es un error de la lectura. Un fallo de la BASE sí sube, y eso es
  // deliberado: confundirlo con "no hay nada" manda al operador a mirar la mesa
  // equivocada.
  async of(matchId: string): Promise<readonly HistoryEntry[]> {
    const document = await (await this.collection()).findOne(
      { matchId },
      { projection: { timeline: 1, entries: 1 } },
    );
    return entriesOf(document);
  }

  async recordOf(matchId: string): Promise<StoredMatchRecord | undefined> {
    const document = await (await this.collection()).findOne({ matchId });
    return document ? { ...largeLast(document), _id: String(document._id) } : undefined;
  }

  // POR SALA Y, SI NO, POR PARTIDA, en dos consultas y no en un `$or`: con un `$or` el que gana entre
  // dos documentos que coincidan es el orden natural de la colección, y acá tiene que ganar la sala.
  async snapshotOf(roomId: string): Promise<StoredMatchRecord | undefined> {
    const collection = await this.collection();
    const options = { projection: { _id: 0 } };
    const document =
      (await collection.findOne({ roomId }, options)) ??
      (await collection.findOne({ matchId: roomId }, options));
    return document ? largeLast(document) : undefined;
  }

  // LA PÁGINA Y SU TOTAL A LA VEZ, cada uno con su índice y su plazo (ver `pageQueryOf` y `totalOf`).
  async list(query: MatchListQuery): Promise<MatchListPage> {
    const collection = await this.collection();
    const page = pageQueryOf(query);
    try {
      const [found, total] = await Promise.all([
        collection.find(page.filter, page.options).toArray(),
        totalOf(query, this.countCap, {
          estimated: () => collection.estimatedDocumentCount({ maxTimeMS: LIST_MAX_TIME_MS }),
          upTo: (limit) => {
            const count = countQueryOf(query, limit);
            return collection.countDocuments(count.filter, count.options);
          },
        }),
      ]);
      const rows = found.map((document) => ({ id: String(document._id), document }));
      return pageOf(rows, query.pageSize, total);
    } catch (error) {
      if (isTimeout(error)) throw new MatchListTimeoutError(error);
      throw error;
    }
  }

  // Todo verbo pasa por acá: encolado por partida, anotado para el drenado y con el fallo logueado y
  // tragado. La promesa que se ANOTA es la que ya tiene el `catch` puesto, y ese orden importa:
  // anotar la cruda dejaría en el `Set` una promesa rechazada, y el `Promise.all` de `drain()` se
  // rompería con el primer lote fallido en vez de esperar a todos.
  private write(
    matchId: string,
    failure: string,
    detail: Record<string, unknown>,
    update: (collection: Collection<MatchHistoryDocument>) => Promise<unknown>,
  ): void {
    const writing = this.queued(matchId, async () => {
      await update(await this.collection());
    }).catch((error) =>
      this.logger.error(`historial: ${failure}`, { matchId, ...detail, error: String(error) }),
    );
    this.inFlight.add(writing);
    void writing.finally(() => this.inFlight.delete(writing));
  }

  /**
   * La cola de UNA partida, que es lo que hace del nacimiento del documento un solo hecho. Una
   * escritura fallida no envenena a las de atrás: la cadena sigue, y la que falló ya lo dijo.
   */
  private queued(matchId: string, write: () => Promise<void>): Promise<void> {
    const next = (this.writing.get(matchId) ?? Promise.resolve()).then(write, write);
    this.writing.set(matchId, next);
    // Se olvida cuando es la última, para que un proceso que vive semanas no guarde una entrada por
    // cada partida que grabó.
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.writing.get(matchId) === next) this.writing.delete(matchId);
      });
    return next;
  }

  private collection(): Promise<Collection<MatchHistoryDocument>> {
    this.prepared ??= this.prepare().catch((error: unknown) => {
      // Se limpia al fallar, igual que el `finally` de `Mongo.ready()`: un Mongo que todavía no había
      // levantado no deja al historial pegado a una promesa rechazada hasta reiniciar.
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  // UN ÍNDICE QUE NO SE PUEDE CREAR NO FRENA EL HISTORIAL. El caso real es el único: una colección
  // vieja con dos documentos de la misma partida, que hace fallar el único. Rechazar acá dejaría a
  // TODAS las partidas sin registro por un problema de dos filas; se loguea —es lo que el operador
  // necesita para limpiarlas— y se graba igual, con la cola como única garantía hasta el próximo
  // arranque.
  private async prepare(): Promise<Collection<MatchHistoryDocument>> {
    const collection = await this.store.collection<MatchHistoryDocument>(HISTORY_COLLECTION);
    await Promise.all(
      HISTORY_INDEXES.map((indexes) =>
        collection.createIndexes(indexes).catch((error: unknown) =>
          this.logger.error("historial: no se pudieron crear los índices; se graba igual", {
            collection: HISTORY_COLLECTION,
            indexes: indexes.map(({ name }) => name),
            error: String(error),
          }),
        ),
      ),
    );
    return collection;
  }
}
