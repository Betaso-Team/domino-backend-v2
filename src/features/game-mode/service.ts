import type { Lease } from "../../shared/mongo-lease.js";
import {
  DuplicateGameModeError,
  GameModeNotFoundError,
  type GameModeRepository,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "./core/catalog.js";
import type { CreateGameMode, GameMode, UpdateGameMode } from "./core/game-mode.js";

// LOS CASOS DE USO DEL CATÁLOGO, reemplazo del `GameModeService` de v1
// (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts`). Lo que cambia respecto de aquél:
// v1 no serializaba NADA detrás de su regla de unicidad (ni lease, ni transacción, ni índice
// único); acá toda mutación corre adentro del lease y de una cola del proceso — ver `queued`.

// EL NOMBRE DEL LEASE DEL ESCRITOR: serializa las mutaciones entre procesos.
export const CATALOG_LEASE = "catalog-writer";

// No se renueva (ver `shared/mongo-lease.ts`), y la contramedida es que adentro no vaya un trabajo
// largo: una mutación son dos lecturas y dos escrituras.
const LEASE_TTL_MS = 15_000;

export class GameModeService {
  // LA COLA DEL PROCESO, Y NO ALCANZA CON EL LEASE. `MongoLease` excluye PROCESOS y no llamadas —su
  // dueño es por proceso, así que dos `POST /game-modes` concurrentes contra la MISMA instancia
  // entran los dos—. Sin esta cola, las dos pasan la consulta de duplicados —que es un `await`, o
  // sea un turno del event loop— antes de que ninguna haya insertado, y el catálogo queda con el
  // par `name + playersQuantity` repetido que la regla existe para prohibir. Ese agujero lo tenía
  // v1: con dinero configurado por modo, dos modos homónimos son dos inscripciones distintas
  // cobrándose por lo que el panel cree que es lo mismo.
  //
  // Cuesta que las mutaciones de una instancia sean estrictamente secuenciales. Es aceptable acá y
  // en ningún otro lugar del servidor: el catálogo recibe unas pocas escrituras por día y ninguna
  // está en el camino de una partida.
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: GameModeRepository,
    private readonly lease: Lease,
  ) {}

  // LAS DOS LECTURAS NO TOMAN EL LEASE, y no es una optimización: un GET público que compitiera por
  // el lease del escritor fallaría con 503 cada vez que el panel está editando, y el lease no
  // protege nada que una lectura pueda romper.
  listActive(): Promise<readonly GameMode[]> {
    return this.repository.active();
  }

  // `undefined` y no un throw, igual que el puerto: desde afuera, un modo dado de baja NO EXISTE, y
  // la frontera HTTP lo convierte en 404. Las mutaciones sí lanzan porque prometen un `GameMode` a
  // secas y no tienen cómo decir "no estaba".
  getActive(uuid: string): Promise<GameMode | undefined> {
    return this.repository.activeByUuid(uuid);
  }

  create(input: CreateGameMode): Promise<GameMode> {
    return this.mutating(async () => {
      // LA REGLA DE v1 AL PIE: `findOne({ name, playersQuantity })`
      // (`game-mode.service.ts:58`), o sea el PAR y no el nombre solo. Una regla más estricta
      // —nombre a secas— rechazaría modos que el panel crea hoy: el catálogo productivo puede tener
      // «Clásica» de dos y «Clásica» de cuatro, que son mesas distintas con premios distintos.
      if (
        await this.nameTakenBy(input.name, (mode) => mode.playersQuantity === input.playersQuantity)
      ) {
        throw new DuplicateGameModeError(
          `ya existe un modo "${input.name}" de ${input.playersQuantity} jugadores`,
        );
      }
      return this.repository.create(input);
    });
  }

  update(uuid: string, input: UpdateGameMode): Promise<GameMode> {
    return this.mutating(async () => {
      const current = await this.found(uuid);
      // ⚠ LA REGLA DE `update` ES OTRA QUE LA DE `create`, Y LA ASIMETRÍA ES DE v1, NO UN DESCUIDO
      // DE ACÁ. Allá `update` consulta `findOne({ name, uuid: { $ne: uuid } })`
      // (`game-mode.service.ts:100-103`): **sólo el nombre**, cruzando mesas de dos y de cuatro, y
      // sólo cuando el nombre cambia (`:99`). Se reproduce en vez de "arreglarse" porque las dos
      // correcciones posibles cambian lo que el panel puede hacer hoy:
      //
      // - unificar hacia el par `name + playersQuantity` AFLOJA la regla, y entonces un `PUT` que
      //   renombra puede dejar dos modos que hoy v1 rechaza renombrar;
      // - unificar `create` hacia el nombre solo APRIETA, y deja de poder crearse la pareja 2P/4P
      //   homónima que el catálogo productivo ya tiene.
      //
      // Ninguna de las dos es una decisión de esta tarea: el catálogo de v1 sigue vivo y el panel es
      // el mismo. Lo que sí queda anotado es el hueco que v1 tiene y que esto hereda: un `PUT` que
      // cambia SÓLO `playersQuantity` no dispara ninguna consulta, así que puede fabricar el par
      // duplicado que `create` prohíbe. Cerrarlo pide decidir primero cuál de las dos reglas vale.
      if (input.name !== undefined && input.name !== current.name) {
        if (await this.nameTakenBy(input.name, (mode) => mode.uuid !== uuid)) {
          throw new DuplicateGameModeError(`ya existe un modo "${input.name}"`);
        }
      }
      return this.write(uuid, input);
    });
  }

  softDelete(uuid: string): Promise<GameMode> {
    return this.mutating(async () => {
      const current = await this.found(uuid);
      if (!current.isActive) {
        throw new GameModeStateConflictError(`el modo ${uuid} ya está inactivo`);
      }
      // SÓLO `isActive`, y por eso no se pasa `current` entero de vuelta: reescribir los demás
      // campos con lo que se acaba de leer convertiría una baja en una edición completa, y pisaría
      // en silencio cualquier cambio que haya entrado entre la lectura y la escritura.
      return this.write(uuid, { isActive: false });
    });
  }

  reactivate(uuid: string): Promise<GameMode> {
    return this.mutating(async () => {
      const current = await this.found(uuid);
      if (current.isActive) {
        throw new GameModeStateConflictError(`el modo ${uuid} ya está activo`);
      }
      return this.write(uuid, { isActive: true });
    });
  }

  // TODA LA LISTA Y UN FILTRO, y no una consulta por nombre. El puerto no tiene `byName` a propósito
  // —agregárselo obliga a los dos adaptadores y a su contrato— y el catálogo son decenas de modos.
  // ponytail: si algún día fueran miles, lo que cambia es el puerto (un `findOne` indexado del lado
  // de Mongo), no esta función.
  private async nameTakenBy(name: string, extra: (mode: GameMode) => boolean): Promise<boolean> {
    // Sin filtro por `isActive`, igual que las dos consultas de v1: un modo dado de baja sigue
    // ocupando su nombre, porque reactivarlo es una operación de un click y ahí aparecería el par
    // repetido.
    return (await this.repository.all()).some((mode) => mode.name === name && extra(mode));
  }

  private async found(uuid: string): Promise<GameMode> {
    const mode = await this.repository.byUuid(uuid);
    // `byUuid` y no `activeByUuid`: el panel edita y reactiva modos dados de baja, y buscarlos con
    // el filtro de activos convertiría toda reactivación en un 404.
    if (!mode) throw new GameModeNotFoundError(`no existe el modo ${uuid}`);
    return mode;
  }

  // SIN DIFF, igual que v1: el repositorio incrementa `__v` en TODA llamada que encuentre el
  // documento, así que dos `PUT` idénticos dan dos revisiones. Comparar campo por campo pediría
  // coincidir EXACTAMENTE con el criterio del `$inc` del repositorio, y el día que no coincida hay
  // un cambio real que se descarta en silencio.
  private async write(uuid: string, changes: UpdateGameMode): Promise<GameMode> {
    const updated = await this.repository.update(uuid, changes);
    // Inalcanzable hoy —la cola y el lease dejan una sola escritura por vez, y `found` ya leyó el
    // modo—, pero el puerto promete `GameMode | undefined` y tragarse el `undefined` con un `as`
    // sería prometer por él.
    if (!updated) throw new GameModeNotFoundError(`no existe el modo ${uuid}`);
    return updated;
  }

  private mutating<T>(work: () => Promise<T>): Promise<T> {
    return this.queued(async () => {
      const done = await this.lease.within(CATALOG_LEASE, LEASE_TTL_MS, work);
      // `undefined` ES "NO LO CONSEGUÍ" y es un desenlace NORMAL: lo tiene otro proceso. Sale como
      // 503 y no como 500 —nadie hizo nada mal y reintentar es la respuesta correcta—. El precio del
      // contrato está escrito en `shared/mongo-lease.ts`: un `work()` que devolviera `undefined` de
      // verdad no se distinguiría, y ninguna de estas cuatro operaciones lo hace.
      if (done === undefined) throw new GameModeWriteBusyError("el catálogo está ocupado");
      return done;
    });
  }

  // LA COLA, en cuatro líneas. `tail` nunca rechaza —se neutraliza abajo— así que una mutación que
  // falla no arrastra a la siguiente; lo que se devuelve es la promesa SIN neutralizar, que es la que
  // el llamador tiene que ver rechazada.
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
