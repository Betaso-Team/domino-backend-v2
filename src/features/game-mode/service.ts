import type { Lease } from "@/shared/mongo-lease.js";
import {
  DuplicateGameModeError,
  GameModeNotFoundError,
  type GameModeRepository,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "./core/catalog.js";
import type { CreateGameMode, GameMode, UpdateGameMode } from "./core/game-mode.js";
import type { GameModeOutbox } from "./outbox.js";

// LOS CASOS DE USO DEL CATÁLOGO, y son el reemplazo del `GameModeService` de v1
// (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts`). Lo que cambia respecto de aquél es
// UNA cosa y define el archivo entero:
//
// **EL REQUEST ADMINISTRATIVO NO ESPERA A RABBIT.** v1 publicaba en línea y se tragaba el fallo en un
// `catch` que sólo logueaba (`:73-78`): con el broker caído, el panel recibía 201 y el consumidor
// nunca se enteraba del modo nuevo. Acá la mutación escribe la base y escribe el outbox; el
// despachador publica después, con confirmación y reintento. Por eso el constructor recibe un
// `GameModeOutbox` y NO el publicador: la tentación no es importar el publicador de una, es
// agregarle "sólo para el create" un `await` a la publicación, y un tipo que no se puede nombrar es
// más barato de auditar que la convención de no hacerlo. `service.test.ts` pinea la lista de imports
// justamente porque los tipos no lo prohíben.
//
// Lo segundo que cambia: v1 no serializaba NADA (ni lease, ni transacción, ni índice único detrás de
// su regla de unicidad). Acá toda mutación corre adentro del lease, y además adentro de una cola del
// proceso — ver `queued`.

// EL NOMBRE DEL LEASE DEL ESCRITOR. Es distinto del del despachador (`OUTBOX_LEASE`) a propósito: un
// `POST /game-modes` y un tick del outbox no se estorban, y compartir el nombre haría que el panel
// esperara a que termine de publicarse el evento anterior.
export const CATALOG_LEASE = "catalog-writer";

// Quince segundos, igual que el del despachador. No se renueva (ver `shared/mongo-lease.ts`), y la
// contramedida es que adentro no vaya un trabajo largo: una mutación son dos lecturas y dos
// escrituras.
const LEASE_TTL_MS = 15_000;

export class GameModeService {
  // LA COLA DEL PROCESO, Y NO ALCANZA CON EL LEASE. `MongoLease` excluye PROCESOS y no llamadas —su
  // dueño es por proceso, así que el filtro de adquisición matchea por `owner` y dos `POST
  // /game-modes` concurrentes contra la MISMA instancia entran los dos (está escrito en el
  // comentario del `owner`, y ahí mismo dice que la contramedida es "una cola en memoria ENCIMA de
  // esto")—. Sin esta cola, las dos llamadas pasan la consulta de duplicados —que es un `await`, o
  // sea un turno del event loop— antes de que ninguna haya insertado, y el catálogo queda con el par
  // `name + playersQuantity` repetido que la regla existe para prohibir. Ese agujero lo tenía v1 y
  // no se porta: con dinero configurado por modo, dos modos homónimos son dos inscripciones
  // distintas cobrándose por lo que el panel cree que es lo mismo.
  //
  // Cuesta que las mutaciones de una instancia sean estrictamente secuenciales. Es aceptable acá y
  // en ningún otro lugar del servidor: el catálogo recibe unas pocas escrituras por día y ninguna
  // está en el camino de una partida.
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: GameModeRepository,
    private readonly outbox: GameModeOutbox,
    private readonly lease: Lease,
    // EL DESPERTADOR COMO CALLBACK Y NO COMO `OutboxDispatcher`. Un servicio que importara la clase
    // cerraría el ciclo servicio → despachador → outbox → servicio; lo cierra el composition root,
    // que es el único que tiene a los dos. Devuelve `void` y no promesa: si esperara, el request
    // administrativo volvería a esperar a Rabbit por la puerta de atrás.
    private readonly wakeDispatcher: () => void,
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
      const created = await this.repository.create(input);
      await this.outbox.enqueueCreated(created);
      return created;
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

  // EL BOTÓN DE "REPUBLICAR TODO" DEL OPERADOR. Va adentro del lease aunque no toque el catálogo:
  // escribe el outbox, y dos operadores apretándolo a la vez son dos lotes entrelazados.
  syncAll(batchId: string): Promise<{ synced: number }> {
    return this.mutating(async () => {
      // `all()` Y NO `active()`, igual que el `/sync` de v1 (`game-mode.service.ts:177-178`): se
      // aprieta justamente cuando el consumidor se quedó sin eventos, y un modo retirado cuyo
      // `updated` se perdió es un modo que del otro lado se sigue ofreciendo para siempre.
      const synced = await this.outbox.sync(await this.repository.all(), batchId);
      return { synced };
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

  // PERSISTIR Y RECIÉN AHÍ ENCOLAR, en ese orden y con las dos esperadas. Al revés se encola el
  // evento de un cambio que la base puede rechazar, y el consumidor termina con un modo que acá no
  // existe.
  //
  // NO HAY DIFF, y es deliberado: el repositorio incrementa `__v` en TODA llamada que encuentre el
  // documento, incluso una cuyo `$set` no cambie nada, así que dos `PUT` idénticos dan las revisiones
  // 1 y 2 y salen dos `game_mode.updated` con el mismo cuerpo. Es lo que hacía v1 —`findOneAndUpdate`
  // + publicar, sin comparar nada (`game-mode.service.ts:110-123`)— y el costo es un evento de más
  // que el consumidor ya deduplica por `id`. Lo que se compra es que "efectivo" no necesite
  // definición: cualquier otra regla (comparar campo por campo, ignorar las fechas) tendría que
  // coincidir EXACTAMENTE con el criterio del `$inc` del repositorio, y el día que no coincida hay un
  // cambio real cuya revisión ya se publicó — o sea un evento descartado en silencio por la clave de
  // deduplicación.
  private async write(uuid: string, changes: UpdateGameMode): Promise<GameMode> {
    const updated = await this.repository.update(uuid, changes);
    // Inalcanzable hoy —la cola y el lease dejan una sola escritura por vez, y `found` ya leyó el
    // modo—, pero el puerto promete `GameMode | undefined` y tragarse el `undefined` con un `as`
    // sería prometer por él.
    if (!updated) throw new GameModeNotFoundError(`no existe el modo ${uuid}`);
    await this.outbox.ensureUpdated(updated);
    return updated;
  }

  private async mutating<T>(work: () => Promise<T>): Promise<T> {
    const result = await this.queued(async () => {
      const done = await this.lease.within(CATALOG_LEASE, LEASE_TTL_MS, work);
      // `undefined` ES "NO LO CONSEGUÍ" y es un desenlace NORMAL: lo tiene otro proceso. Sale como
      // 503 y no como 500 —nadie hizo nada mal y reintentar es la respuesta correcta—. El precio del
      // contrato está escrito en `shared/mongo-lease.ts`: un `work()` que devolviera `undefined` de
      // verdad no se distinguiría, y ninguna de estas cinco operaciones lo hace.
      if (done === undefined) throw new GameModeWriteBusyError("el catálogo está ocupado");
      return done;
    });
    // SE DESPIERTA SÓLO DESPUÉS DEL ÉXITO, y "éxito" incluye que el outbox haya aceptado la entrada.
    // Despertar tras un fallo sería apurar un despachador que no tiene nada nuevo que publicar: si
    // el lease no se consiguió no se escribió nada, y si el que falló fue el outbox lo que hay que
    // correr es la reconciliación, que el tick de un segundo ya hace sola. Y va DESPUÉS de la cola,
    // no adentro: el panel no espera a que se publique, sólo a que esté anotado.
    this.wakeDispatcher();
    return result;
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
