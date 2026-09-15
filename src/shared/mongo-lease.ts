import { randomUUID } from "node:crypto";
import type { Collection, Document } from "mongodb";

// EXCLUSIÓN DISTRIBUIDA, y una sola primitiva. Es lo que hace que varias instancias del dominó no
// pisen el mismo trabajo administrativo: el catálogo de modos no tiene un índice único sobre
// `name + playersQuantity` —v1 no lo tiene y esta migración conserva la colección tal cual—, así que
// la regla de "no repetir" es una consulta seguida de una escritura. Sin lease, dos procesos pasan
// los dos la consulta y insertan los dos. Lo mismo del otro lado: dos dispatchers del outbox
// publicarían el mismo evento.
//
// ⚠ **v1 NO SERIALIZA NADA DE ESTO, y por eso esta pieza es nueva y no un port.** Su
// `GameModeService.create` hace `findOne({ name, playersQuantity })` y después `create(...)` sin
// lock, sin transacción y sin índice que lo respalde
// (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:57-69`); su `update` compara sólo el
// nombre (`:100-103`). Los únicos `Mutex` de v1 (`async-mutex`) son DE PROCESO y son de las salas y
// del matchmaking del lobby (`rooms/domino-four-room.ts:47`, `rooms/lobby-room.ts:42`) — el catálogo
// no toca ninguno. O sea: v2 es estrictamente más fuerte que v1 acá, no compatible-y-distinto.
//
// Vive en `shared/` porque su ciclo de vida es del PROCESO y no de una feature, y porque lo usan dos
// consumidores de la misma feature por caminos distintos (el servicio del catálogo y el dispatcher
// del outbox). No importa nada de `features/`: es la regla de imports que lo obliga y también lo que
// lo hace verdad — un lease no sabe qué se serializa adentro.

// LA COLECCIÓN, en una constante y no en una variable de entorno, por el mismo argumento que
// `HISTORY_COLLECTION` y `GAME_MODE_COLLECTION`: el dominó es su único escritor, así que un nombre
// configurable sería un valor que nadie cambia y que se puede escribir mal — y escribirlo mal acá es
// dos procesos que creen tener el lock porque están mirando colecciones distintas.
export const LEASE_COLLECTION = "game_mode_leases";

// EL CÓDIGO DE CLAVE DUPLICADA de Mongo. Se compara el NÚMERO y nunca el texto: el mensaje real trae
// el namespace, el nombre del índice y la clave (`E11000 duplicate key error collection: …`), cambia
// entre versiones del servidor y está pensado para un humano. Y tampoco un `instanceof
// MongoServerError`, que obliga a importar el paquete como valor y falla en silencio el día que haya
// dos copias del driver en el árbol de dependencias.
const DUPLICATE_KEY = 11000;

// LA PRIMITIVA, y es una sola. `within` corre el trabajo SÓLO si consiguió el lease.
//
// **`undefined` SIGNIFICA "NO SE ADQUIRIÓ", y es un desenlace normal y no un error.** De eso cuelgan
// los dos consumidores: el servicio del catálogo lo convierte en un 503 (`GameModeWriteBusyError`) y
// el dispatcher del outbox se saltea el tick. Un `within` que lanzara en vez de devolver `undefined`
// haría que un catálogo ocupado se viera como una caída, y el operador buscaría el problema en la
// base. El precio del contrato está escrito: un `work()` que devuelve `undefined` de verdad no se
// distingue de un lease no adquirido. Ninguno de los dos llamadores lo hace.
//
// NO RENUEVA el lease mientras el trabajo corre, y eso es deliberado. Lo que hay que saber: si
// `work()` tarda MÁS que `ttlMs`, otro proceso puede tomar el lease y ejecutar en paralelo, y el
// primero no se entera. La contramedida no es un renovador —es una pieza con su propio temporizador,
// su propio fallo y su propia carrera—, es que adentro del lease no vayan trabajos largos: el
// dispatcher toma UNA entrada por tick y no un bucle, y una mutación del catálogo son dos escrituras
// a Mongo. Si algún día hace falta un trabajo largo, se parte en pasos, no se agrega renovación.
export interface Lease {
  within<T>(name: string, ttlMs: number, work: () => Promise<T>): Promise<T | undefined>;
}

// LO MÍNIMO QUE ESTE ADAPTADOR NECESITA de la conexión, declarado como interfaz estructural y no como
// la clase `Mongo`. Es el tercer gemelo de lo mismo (`HistoryStore` en `mongo-history.ts`,
// `CollectionSource` en `game-mode/transports/mongo-repository.ts`): `Mongo` los satisface a los tres
// sin saberlo, así que el cableado no cambia y la suite le puede dar un doble sin un
// `as unknown as Mongo`. Repetido y no compartido a propósito de este lado: `shared/` no puede
// importar de `features/`, y bajar la de la feature hasta acá la volvería un tipo que ninguna de las
// dos puntas declara.
export interface CollectionSource {
  collection<T extends Document>(name: string): Promise<Collection<T>>;
}

// El reloj INYECTADO, no `Date.now()` directo: es lo que permite que la suite mida el vencimiento sin
// esperar quince segundos de verdad. Se redeclara acá por lo mismo que en
// `game-mode/transports/mongo-repository.ts` — el tipado estructural une las dos sin que ninguna sepa
// de la otra.
export interface Clock {
  now(): number;
}

// EL DOCUMENTO, uno por NOMBRE de trabajo. `_id = name` y no un `_id` propio con un índice único
// aparte: el `_id` ya es único por construcción, así que la unicidad la da la base sin un índice que
// crear ni mantener — y por eso este adaptador no llama `createIndexes` ni memoiza la colección.
//
// Sin TTL index: los documentos son DOS (`catalog-writer` y `outbox-publisher`) y no crecen. Un
// índice TTL borraría el documento vencido en segundo plano, que es trabajo de la base para algo que
// el filtro de adquisición ya resuelve leyendo `until`.
export interface LeaseDocument {
  _id: string;
  owner: string;
  until: Date;
}

export class MongoLease implements Lease {
  // EL DUEÑO ES POR PROCESO Y NO POR LLAMADA, y esa elección tiene dos caras.
  //
  // A favor: un `release` que no llegó a la base —un corte de red justo al salir— no deja al proceso
  // esperando su propio vencimiento; su próxima adquisición matchea por `owner` y entra.
  //
  // En contra, y hay que saberlo: **este lease excluye PROCESOS, no llamadas concurrentes del mismo
  // proceso.** Dos mutaciones del catálogo que lleguen a la misma instancia entran las dos, y un
  // `within` anidado LIBERA al salir del de adentro, dejando al de afuera corriendo sin lease. Si
  // algún día hace falta serializar también adentro del proceso, es una cola en memoria ENCIMA de
  // esto y no un cambio acá: darle un dueño por llamada rompería la primera cara.
  private readonly owner = randomUUID();

  constructor(
    private readonly source: CollectionSource,
    private readonly clock: Clock,
  ) {}

  async within<T>(name: string, ttlMs: number, work: () => Promise<T>): Promise<T | undefined> {
    if (!(await this.acquire(name, ttlMs))) return undefined;
    let result: T;
    try {
      result = await work();
    } catch (error) {
      // EL ERROR DEL TRABAJO GANA. Se libera igual —un trabajo que falló no puede dejar el catálogo
      // bloqueado hasta el vencimiento— pero un fallo de ESA liberación se descarta: reemplazar el
      // error original por "no pude borrar el lease" manda a soporte a mirar la pieza equivocada, y
      // el vencimiento ya es la red de contención.
      await this.release(name).catch(() => {});
      throw error;
    }
    // Acá, en cambio, el fallo SÍ sube: el trabajo salió bien y lo único que falló es la base. Es la
    // misma ambigüedad que la spec ya declara para la ventana modo→outbox (§9.2, "el HTTP devuelve
    // 503 aunque el cambio puede haber quedado aplicado; el orquestador debe releer el catálogo
    // antes de reintentar"), y tragársela acá sería inventar una segunda regla para el mismo caso.
    await this.release(name);
    return result;
  }

  // UNA SOLA OPERACIÓN ATÓMICA, y es la línea entera de este archivo. Leer y después escribir —
  // `findOne` y `updateOne`— es el bug clásico: entre las dos hay un turno del event loop, y dos
  // procesos que lo aprovechen ven los dos el lease libre y escriben los dos. Mongo garantiza la
  // atomicidad sobre UN documento, así que la decisión y la escritura tienen que ir en el mismo
  // `findOneAndUpdate`.
  private async acquire(name: string, ttlMs: number): Promise<boolean> {
    const now = new Date(this.clock.now());
    const until = new Date(now.getTime() + ttlMs);
    try {
      await (await this.collection()).findOneAndUpdate(
        {
          _id: name,
          // Se toma si está VENCIDO o si ya es MÍO. Con `$lte` y no `$lt`: `until` es el instante en
          // que deja de valer, no el último en que vale.
          $or: [{ until: { $lte: now } }, { owner: this.owner }],
        },
        { $set: { owner: this.owner, until } },
        // `upsert` porque el primer uso de cada nombre no tiene documento que actualizar. Y acá
        // aparece el E11000: cuando el documento YA existe y el `$or` no lo eligió, Mongo deriva el
        // `_id` del insert de la igualdad del filtro y choca con el que está. O sea que el duplicado
        // no es una rareza de carrera — es el camino ORDINARIO de "lo tiene otro".
        //
        // SIN `returnDocument`, y la ausencia es la decisión: el documento devuelto no se lee. Lo
        // que decide si se adquirió es que la operación NO HAYA LANZADO —el `$set` acaba de escribir
        // este mismo `owner`, así que inspeccionarlo sería preguntar por lo que se acaba de
        // afirmar—. Pedir `after` "por las dudas" es configuración muerta: parece que alguien mira
        // el resultado, y el que venga a cambiar esta línea va a buscar al lector que no existe.
        { upsert: true },
      );
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      // Cualquier otro fallo SUBE. Tratar todo error de la base como "ocupado" convertiría un Mongo
      // caído en un 503 de "catálogo ocupado" eterno, y el operador iría a buscar al proceso que
      // tiene el lock en vez de a la base que no contesta.
      throw error;
    }
  }

  // SÓLO EL PROPIO, y el `owner` del filtro es la guarda más peligrosa del archivo. Un proceso cuyo
  // lease venció mientras trabajaba —el caso del `work()` que tardó más que `ttlMs`— tiene que poder
  // salir SIN borrar el lease que ya tomó otro: con `{ _id: name }` a secas, el que se fue le abre la
  // puerta a un tercero mientras el dueño legítimo sigue adentro, y entonces hay dos escritores del
  // catálogo sin que nada falle.
  private async release(name: string): Promise<void> {
    await (await this.collection()).deleteOne({ _id: name, owner: this.owner });
  }

  private collection(): Promise<Collection<LeaseDocument>> {
    return this.source.collection<LeaseDocument>(LEASE_COLLECTION);
  }
}

// EL LEASE DE LA INSTANCIA QUE NO TIENE MONGO, y NO un doble de test: es lo que el proceso sin
// `MONGO_URI` despliega, igual que `MemoryHistory` y `MemoryGameModeRepository`. Vive en este archivo
// y no en uno propio por el mismo criterio que `MemoryKeyValueStore` en `shared/kv.ts`: el puerto y
// sus implementaciones se leen de un tirón, y son cinco líneas.
//
// **CORRE SIEMPRE, y eso es la semántica correcta y no un atajo.** Este lease excluye PROCESOS (ver
// el comentario del `owner` de arriba), y un proceso sin almacén compartido no tiene con quién
// competir: lo que el adaptador Mongo hace contra un solo dueño es exactamente esto, adquirir siempre
// —su filtro matchea por `owner`—. Guardar un `Map` de leases acá simularía una negación que ni
// siquiera el adaptador real produce contra sí mismo, y la suite terminaría certificando una
// exclusión que producción no tiene.
export class MemoryLease implements Lease {
  async within<T>(_name: string, _ttlMs: number, work: () => Promise<T>): Promise<T | undefined> {
    return work();
  }
}

// Estructural y por CÓDIGO, no `instanceof` ni una expresión regular sobre el mensaje. Ver
// `DUPLICATE_KEY`.
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
