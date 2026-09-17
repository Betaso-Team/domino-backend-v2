import type { Logger } from "@/logger";
import type { Collection, Document } from "mongodb";
import type { HistoryEntry, HistoryPort, HistoryReader } from "../history";

// EL HISTORIAL QUE SOBREVIVE AL REINICIO. `MemoryHistory` tiene tope de 200 partidas y muere
// con el proceso, así que el endpoint interno de soporte y el CLI de replay —los dos ya
// construidos— no tenían nada que mostrar de ayer. Ésta es la brecha que cierra.
//
// **Un documento por PARTIDA**, con las entradas empujadas en lotes. La granularidad es
// deliberada: una fila por partida, buscable por `matchId`, en vez de multiplicar por cien
// los documentos. Una partida de dominó deja del orden de cien a doscientas entradas, así
// que el techo de 16 MB por documento ni se acerca.

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

// LA FORMA DEL DOCUMENTO, declarada: es lo que hace que el `$push` y la lectura tipen sin
// castear, y de paso deja a la vista qué se guarda.
//
// SIN CAMPO `version`, que es la segunda decisión propia. Truco lo lleva porque comparte la
// colección con el motor v1 y necesita distinguir sus filas de las ajenas; acá la colección
// tiene un solo escritor, así que un marcador de versión no discrimina nada. Guardarlo
// "por las dudas" sería un campo que miente sobre la existencia de un segundo motor, y el
// día que de verdad haya dos formas de documento va a hacer falta una migración, no un
// número que nadie leyó nunca.
//
// `createdAt`/`updatedAt` SÍ quedan, y no son campos derivados de `entries` aunque lo
// parezcan: `entry.at` sale del `Clock` INYECTADO —que el replay y la suite reemplazan— y
// estos dos son el instante real de la escritura. Es lo único que deja barrer la colección
// por antigüedad sin abrir cada documento, que es lo que hace falta el día que haya que
// expirarla.
export interface MatchHistoryDocument {
  readonly matchId: string;
  readonly entries: HistoryEntry[];
  readonly createdAt: Date;
  updatedAt: Date;
}

export class MongoHistory implements HistoryPort, HistoryReader {
  // LOS LOTES QUE TODAVÍA ESTÁN VIAJANDO. Es lo único que hace falta para que el apagado
  // pueda esperarlos, y es un `Set` y no un contador porque lo que se espera son las
  // promesas mismas.
  //
  // No crece sin control: cada entrada se borra cuando su escritura termina, bien o mal. En
  // régimen tiene el tamaño de la concurrencia real —una escritura por lote en vuelo—, no
  // el del historial.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly store: HistoryStore,
    private readonly logger: Logger,
  ) {}

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
    // La promesa que se ANOTA es la que ya tiene el `catch` puesto, y ese orden importa:
    // anotar la cruda dejaría en el `Set` una promesa rechazada, y el `Promise.all` de
    // `drain()` se rompería con el primer lote fallido en vez de esperar a todos.
    const writing = this.append(matchId, entries).catch((error) =>
      this.logger.error("historial: no se pudo grabar el lote", {
        matchId,
        entries: entries.length,
        error: String(error),
      }),
    );
    this.inFlight.add(writing);
    void writing.finally(() => this.inFlight.delete(writing));
  }

  // Ver el comentario de `HistoryPort.drain`. EN BUCLE y no una sola pasada: nada impide que
  // un lote que estaba en vuelo dispare otro —el `finally` que limpia el `Set` corre después
  // de que la promesa resuelve—, y un drenado que espera una sola tanda dejaría justo al
  // último afuera. Termina porque durante el apagado ya no hay salas que graben: la sala se
  // dispone ANTES de que esto corra (§`src/main.ts`).
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      // `all` y no `allSettled` porque ninguna de estas promesas puede rechazar: son las que
      // salieron del `catch` de arriba.
      await Promise.all([...this.inFlight]);
    }
  }

  async of(matchId: string): Promise<readonly HistoryEntry[]> {
    const document = await (await this.collection()).findOne({ matchId });
    // Vacío y no un fallo cuando no hay documento: sus dos llamadores ya distinguen ese caso
    // —el endpoint interno responde 404, el CLI corta con "no hay historial"— y una partida
    // que no existe no es un error de la lectura. Un fallo de la BASE sí sube, y eso es
    // deliberado: confundirlo con "no hay nada" manda al operador a mirar la mesa
    // equivocada.
    return document?.entries ?? [];
  }

  private collection(): Promise<Collection<MatchHistoryDocument>> {
    return this.store.collection<MatchHistoryDocument>(HISTORY_COLLECTION);
  }

  private async append(matchId: string, entries: readonly HistoryEntry[]): Promise<void> {
    const now = new Date();
    await (await this.collection()).updateOne(
      { matchId },
      {
        // `$push` con `$each` y NUNCA `$set` sobre `entries`: cada lote se agrega al final,
        // que es lo que hace que el `seq` siga siendo el orden. Con `$set` el documento
        // quedaría con el último lote y el historial sería siempre la última jugada.
        $push: { entries: { $each: [...entries] } },
        $set: { updatedAt: now },
        // La cabecera se escribe UNA SOLA VEZ, con el primer lote. `$setOnInsert` y no
        // `$set` porque describe el nacimiento del documento: con `$set`, `createdAt`
        // avanzaría con cada jugada y dejaría de ser el instante en que la partida empezó a
        // grabarse.
        $setOnInsert: { matchId, createdAt: now },
      },
      { upsert: true },
    );
  }
}
