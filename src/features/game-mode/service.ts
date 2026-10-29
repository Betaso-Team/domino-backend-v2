import type { Lease } from "@/shared/mongo-lease";
import { uuidV5 } from "./copy-uuid";
import {
  type CatalogActor,
  type CatalogSource,
  DuplicateGameModeError,
  FreeRoomWithEntryError,
  GameModeForbiddenError,
  GameModeNotFoundError,
  type GameModeRepository,
  GameModeStateConflictError,
  GameModeWriteBusyError,
  type ProviderCatalog,
  type ProviderCatalogRepository,
  offeredTo,
  visibleTo,
} from "./core/catalog";
import type { CreateGameMode, GameMode, UpdateGameMode } from "./core/game-mode";

// EL ÁMBITO DE LOS PROVEEDORES, en tres reglas que todas las operaciones de acá comparten:
//
// 1. **Un modo propio de OTRO proveedor no existe**: sale como 404 en toda operación, nunca como 403.
//    Decir «no podés» sobre algo que no ve le confirmaría que existe.
// 2. **Un compartido no es secreto pero no es suyo**: lo lista el catálogo público, así que tocarlo
//    es 403 y no 404. Se lee y se juega; lo editan, lo dan de baja y lo reactivan sólo en Betaso
//    Games.
// 3. **Cada proveedor habla por sí mismo**: crea modos propios suyos, se suscribe él, copia para él.
//    Pedirlo para otro es 403 antes de leer nada. El proveedor sobre el que se actúa llega YA RESUELTO
//    por la frontera HTTP (el del token, o el `?providerId=` de Betaso Games); el chequeo de acá es la
//    segunda llave, para el día que otro llamador se olvide de la primera.
//
// Betaso Games (`provider: null`) pasa las tres. El rol (`support` sólo lee) lo resuelve la puerta
// HTTP antes de llegar acá: este servicio sólo sabe de QUIÉN es cada modo.
//
// ⚠ EL DUEÑO NO SE VERIFICA AL ABRIR UNA MESA. `POST /internal/matches` resuelve el modo activo por
// uuid sin preguntar de qué proveedor es (`match-contract.ts`): que un jugador sólo use los modos de
// su proveedor lo garantiza el ORQUESTADOR, que es quien arma el catálogo efectivo de cada uno.

// LA COPIA DE UN COMPARTIDO A UN PROVEEDOR: qué pasó con cada modo de origen.
export interface CopiedMode {
  readonly sourceUuid: string;
  readonly uuid: string;
}

export interface SkippedCopy {
  readonly sourceUuid: string;
  readonly name: string;
  readonly playersQuantity: 2 | 4;
  // `NAME_TAKEN`: el proveedor ya tiene un modo propio con ese nombre y esa cantidad, con OTRO uuid
  // —uno que creó él—, y la regla de unicidad lo impide. `INVALID_SOURCE_UUID`: el origen no tiene
  // un uuid del que derivar el de la copia (los legados de v1 no garantizan la forma).
  readonly reason: "NAME_TAKEN" | "INVALID_SOURCE_UUID";
  readonly conflictUuid?: string;
}

export interface CopiesResult {
  readonly created: readonly CopiedMode[];
  // Ya estaban, de una copia anterior: se dejan como están, el proveedor puede haberlas editado.
  readonly existing: readonly CopiedMode[];
  readonly skipped: readonly SkippedCopy[];
}

// LOS CASOS DE USO DEL CATÁLOGO, y son el reemplazo del `GameModeService` de v1
// (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts`). Lo que cambia respecto de aquél:
//
// **EL CATÁLOGO NO PUBLICA A NINGÚN BROKER.** v1 publicaba cada cambio al exchange `betaso` de Betaso;
// v2 lo hizo un tiempo con un outbox, y se eliminó cuando Betaso pasó a leer los modos de dominó del
// orquestador (`GET /v1/game-modes`), que los lee de acá. Una mutación escribe la base y nada más.
// `service.int.test.ts` pinea la lista de imports para que ningún broker vuelva a entrar por acá.
//
// v1 no serializaba NADA (ni lease, ni transacción, ni índice único detrás de su regla de unicidad).
// Acá toda mutación corre adentro del lease, y además adentro de una cola del proceso — ver `queued`.

// EL NOMBRE DEL LEASE DEL ESCRITOR. Es distinto del del despachador de resultados a propósito: no
// se estorban.
export const CATALOG_LEASE = "catalog-writer";

// El mensaje es el que el panel muestra, el mismo texto que truco.
function refuseChargedFreeRoom(mode: { isFreeRoom?: boolean; entryFee: number }): void {
  if (mode.isFreeRoom === true && mode.entryFee > 0) {
    throw new FreeRoomWithEntryError("una mesa gratis no puede tener entrada");
  }
}

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
    private readonly catalogs: ProviderCatalogRepository,
    private readonly lease: Lease,
  ) {}

  // LAS LECTURAS NO TOMAN EL LEASE, y no es una optimización: un GET público que compitiera por el
  // lease del escritor fallaría con 503 cada vez que el panel está editando, y el lease no protege
  // nada que una lectura pueda romper.
  //
  // LO PÚBLICO SON LOS COMPARTIDOS ACTIVOS, y nada más: un modo propio es la configuración de UN
  // proveedor y no se publica a quien no se identificó. Tampoco viajan los suscriptores.
  async listPublic(): Promise<readonly GameMode[]> {
    return (await this.repository.active()).filter((mode) => mode.ownerProviderId === null);
  }

  // `undefined` y no un throw, igual que el puerto: desde afuera, un modo dado de baja NO EXISTE, y
  // la frontera HTTP lo convierte en 404. Las mutaciones sí lanzan porque prometen un `GameMode` a
  // secas y no tienen cómo decir "no estaba". Un modo propio tampoco existe desde afuera.
  async getPublic(uuid: string): Promise<GameMode | undefined> {
    const mode = await this.repository.activeByUuid(uuid);
    return mode?.ownerProviderId === null ? mode : undefined;
  }

  // EL CATÁLOGO ENTERO PARA EL ORQUESTADOR, con dueños y suscriptores: es quien arma el catálogo
  // efectivo de cada proveedor. Los inactivos van sólo si los pide, para resolver el modo de una
  // partida vieja.
  //
  // VA CON LAS FUENTES QUE SE APARTAN DEL DEFAULT (`own`): con eso el orquestador decide, por
  // proveedor, si su catálogo es el compartido suscrito o sólo sus propios. Un proveedor ausente está
  // en `shared`.
  async listInternal({ includeInactive }: { includeInactive: boolean }): Promise<{
    readonly modes: readonly GameMode[];
    readonly catalogs: readonly ProviderCatalog[];
  }> {
    const [modes, catalogs] = await Promise.all([
      includeInactive ? this.repository.all() : this.repository.active(),
      this.catalogs.nonShared(),
    ]);
    return { modes, catalogs };
  }

  // LA FUENTE DEL CATÁLOGO DE UN PROVEEDOR. La lee cualquier rol del proveedor o de Betaso Games; otro
  // proveedor es 403 (los ids de proveedor no son secretos, la fuente de un competidor sí).
  catalogOf(actor: CatalogActor, providerId: string): Promise<ProviderCatalog> {
    try {
      refuseForeign(actor, providerId, "un proveedor sólo ve la fuente de su propio catálogo");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.catalogs.of(providerId);
  }

  // CAMBIAR LA FUENTE. Pasar a `own` exige AL MENOS UN MODO PROPIO ACTIVO del proveedor: sin eso el
  // proveedor quedaría con un catálogo vacío, o sea sin lobby. Volver a `shared` siempre se puede.
  // Adentro del lease y la cola, como toda escritura del catálogo: la comprobación y la escritura
  // no se cruzan con una baja del último propio.
  //
  // Lo que NO se impide es dar de baja después el último propio con la fuente en `own`: eso lo ve
  // el proveedor en su propio panel, y el orquestador no ofrece mesas de un catálogo vacío.
  setCatalogSource(
    actor: CatalogActor & { readonly name: string },
    providerId: string,
    source: CatalogSource,
  ): Promise<ProviderCatalog> {
    try {
      refuseForeign(actor, providerId, "un proveedor sólo elige la fuente de su propio catálogo");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutating(async () => {
      if (source === "own") {
        const owned = (await this.repository.active()).some(
          (mode) => mode.ownerProviderId === providerId,
        );
        if (!owned) {
          throw new GameModeStateConflictError(
            `el proveedor ${providerId} no tiene modos propios activos: no puede jugar sólo con los suyos`,
          );
        }
      }
      return this.catalogs.set(providerId, source, actor.name);
    });
  }

  // LAS DOS LECTURAS DEL PANEL: ven también a los dados de baja, porque reactivar exige poder
  // listarlos y abrirlos primero. Igual que las públicas, sin lease; la frontera HTTP las
  // pone detrás de la llave, no el servicio. Cada proveedor ve lo que `visibleTo` le deja.
  //
  // CON `providerId`, LO QUE VE ESE PROVEEDOR: así Betaso Games mira el catálogo de uno desde el panel
  // (`?providerId=`). Un proveedor sólo puede pedir el suyo, que es lo mismo que no pedir nada.
  async listFor(actor: CatalogActor, providerId?: string): Promise<readonly GameMode[]> {
    if (providerId !== undefined)
      refuseForeign(actor, providerId, "un proveedor sólo ve su propio catálogo");
    const viewer = providerId === undefined ? actor : { provider: providerId };
    return (await this.repository.all()).filter((mode) => visibleTo(mode, viewer));
  }

  async getFor(actor: CatalogActor, uuid: string): Promise<GameMode | undefined> {
    const mode = await this.repository.byUuid(uuid);
    return mode && visibleTo(mode, actor) ? mode : undefined;
  }

  create(actor: CatalogActor, input: CreateGameMode): Promise<GameMode> {
    // EL DUEÑO SE DECIDE ANTES DE TOCAR NADA: un proveedor crea sólo modos propios suyos —sin el campo,
    // se lo pone el servicio; con el de otro, o con `null` (compartido), es 403—; Betaso Games crea
    // compartidos por default o propios del proveedor que nombre.
    let owner: string | null;
    try {
      owner = ownerFor(actor, input.ownerProviderId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutating(async () => {
      refuseChargedFreeRoom(input);
      // LA REGLA DE v1 AL PIE: `findOne({ name, playersQuantity })`
      // (`game-mode.service.ts:58`), o sea el PAR y no el nombre solo. Una regla más estricta
      // —nombre a secas— rechazaría modos que el panel crea hoy: el catálogo productivo puede tener
      // «Clásica» de dos y «Clásica» de cuatro, que son mesas distintas con premios distintos.
      //
      // POR DUEÑO: la regla compara contra los modos del MISMO dueño (los compartidos entre sí, los
      // de cada proveedor entre sí). Un proveedor que copia «Clásica» de los compartidos no choca con
      // la compartida, y dos proveedores pueden tener cada uno su «Clásica».
      if (
        await this.nameTakenBy(
          input.name,
          owner,
          (mode) => mode.playersQuantity === input.playersQuantity,
        )
      ) {
        throw new DuplicateGameModeError(
          `ya existe un modo "${input.name}" de ${input.playersQuantity} jugadores`,
        );
      }
      return this.repository.create({ ...input, ownerProviderId: owner });
    });
  }

  update(actor: CatalogActor, uuid: string, input: UpdateGameMode): Promise<GameMode> {
    return this.mutating(async () => {
      const current = await this.editable(actor, uuid);
      // CONTRA EL MODO QUE QUEDA y no contra el parche: el que le pone entrada a una mesa gratis no
      // manda la bandera. Pero SOLO si el parche toca uno de los dos campos: el catálogo es el de v1,
      // que no lo impedía, y trabarle el premio a un modo heredado contradictorio no lo arregla.
      if (input.isFreeRoom !== undefined || input.entryFee !== undefined) {
        refuseChargedFreeRoom({ ...current, ...input });
      }
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
      //
      // Y COMO EN `create`, POR DUEÑO: el renombre choca sólo con los modos del mismo dueño.
      if (input.name !== undefined && input.name !== current.name) {
        if (
          await this.nameTakenBy(input.name, current.ownerProviderId, (mode) => mode.uuid !== uuid)
        ) {
          throw new DuplicateGameModeError(`ya existe un modo "${input.name}"`);
        }
      }
      if (input.isActive === false) await this.refuseEmptyingOwnCatalog(current);
      return this.write(uuid, input);
    });
  }

  softDelete(actor: CatalogActor, uuid: string): Promise<GameMode> {
    return this.mutating(async () => {
      const current = await this.editable(actor, uuid);
      if (!current.isActive) {
        throw new GameModeStateConflictError(`el modo ${uuid} ya está inactivo`);
      }
      // SÓLO `isActive`, y por eso no se pasa `current` entero de vuelta: reescribir los demás
      // campos con lo que se acaba de leer convertiría una baja en una edición completa, y pisaría
      // en silencio cualquier cambio que haya entrado entre la lectura y la escritura.
      //
      // LOS SUSCRIPTORES SE QUEDAN: la baja de un compartido no los vacía, así que reactivarlo lo
      // vuelve a ofrecer a los mismos proveedores. El catálogo efectivo ya excluye los inactivos.
      await this.refuseEmptyingOwnCatalog(current);
      return this.write(uuid, { isActive: false });
    });
  }

  reactivate(actor: CatalogActor, uuid: string): Promise<GameMode> {
    return this.mutating(async () => {
      const current = await this.editable(actor, uuid);
      if (current.isActive) {
        throw new GameModeStateConflictError(`el modo ${uuid} ya está activo`);
      }
      return this.write(uuid, { isActive: true });
    });
  }

  // UN PROVEEDOR SE SUSCRIBE A UN COMPARTIDO ACTIVO, o se da de baja. Betaso Games puede hacerlo por
  // cualquiera. No mueve la revisión (ver el puerto).
  subscribe(actor: CatalogActor, uuid: string, providerId: string): Promise<GameMode> {
    return this.changeSubscription(actor, uuid, providerId, "add");
  }

  unsubscribe(actor: CatalogActor, uuid: string, providerId: string): Promise<GameMode> {
    return this.changeSubscription(actor, uuid, providerId, "remove");
  }

  // LA COPIA DE LOS COMPARTIDOS QUE UN PROVEEDOR JUEGA a modos propios suyos: lo que pide pasar a
  // jugar con valores propios: los compartidos activos con él en la lista de suscriptores.
  //
  // UNA SOLA VEZ POR MODO Y DETERMINISTA: el uuid de la copia es el v5 de (origen, proveedor), así que
  // reintentar después de una copia a medias crea lo que faltó y deja como está lo que ya se copió
  // —aunque el proveedor lo haya editado o dado de baja—. Un modo propio que el proveedor ya tenía con
  // el mismo nombre y la misma cantidad, con OTRO uuid, no se pisa ni se duplica: se saltea y se
  // informa.
  //
  // Toda la copia va en UN turno del lease. Son decenas de modos y dos escrituras como mucho cada
  // uno; si el catálogo creciera hasta acercarse al plazo del lease, lo que cambia es tomar un turno
  // por modo —el reintento ya es seguro—, no la regla.
  createCopies(actor: CatalogActor, providerId: string): Promise<CopiesResult> {
    try {
      refuseForeign(actor, providerId, "un proveedor sólo copia los compartidos para sí mismo");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutating(async () => {
      const all = [...(await this.repository.all())];
      const sources = all.filter(
        (mode) => mode.ownerProviderId === null && mode.isActive && offeredTo(mode, providerId),
      );
      const created: CopiedMode[] = [];
      const existing: CopiedMode[] = [];
      const skipped: SkippedCopy[] = [];
      for (const source of sources) {
        const uuid = uuidV5(source.uuid, providerId);
        const summary = {
          sourceUuid: source.uuid,
          name: source.name,
          playersQuantity: source.playersQuantity,
        };
        if (!uuid) {
          skipped.push({ ...summary, reason: "INVALID_SOURCE_UUID" });
          continue;
        }
        if (all.some((mode) => mode.uuid === uuid)) {
          existing.push({ sourceUuid: source.uuid, uuid });
          continue;
        }
        const clash = all.find(
          (mode) =>
            mode.ownerProviderId === providerId &&
            mode.name === source.name &&
            mode.playersQuantity === source.playersQuantity,
        );
        if (clash) {
          skipped.push({ ...summary, reason: "NAME_TAKEN", conflictUuid: clash.uuid });
          continue;
        }
        const written = await this.repository.insertIfAbsent(uuid, copyOf(source, providerId));
        (written.created ? created : existing).push({ sourceUuid: source.uuid, uuid });
        // A LA LISTA DE LA CORRIDA, para que dos compartidos homónimos —el hueco heredado del `PUT`
        // los puede fabricar— no den dos copias que se salteen la regla de unicidad.
        all.push(written.mode);
      }
      return { created, existing, skipped };
    });
  }

  private changeSubscription(
    actor: CatalogActor,
    uuid: string,
    providerId: string,
    change: "add" | "remove",
  ): Promise<GameMode> {
    try {
      refuseForeign(actor, providerId, "un proveedor sólo se suscribe o se da de baja a sí mismo");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutating(async () => {
      const current = await this.found(uuid);
      if (current.ownerProviderId !== null) {
        // Uno propio de OTRO proveedor no existe para éste (regla 1).
        if (actor.provider !== null && current.ownerProviderId !== actor.provider) {
          throw notFound(uuid);
        }
        throw new GameModeStateConflictError(`el modo ${uuid} es propio y no tiene suscriptores`);
      }
      if (!current.isActive) {
        throw new GameModeStateConflictError(`el modo ${uuid} está inactivo`);
      }
      const updated =
        change === "add"
          ? await this.repository.addSubscriber(uuid, providerId)
          : await this.repository.removeSubscriber(uuid, providerId);
      return this.subscribersWritten(uuid, updated);
    });
  }

  // Inalcanzable hoy por lo mismo que en `write`: la cola y el lease dejan una sola escritura por vez.
  private subscribersWritten(uuid: string, updated: GameMode | undefined): GameMode {
    if (!updated) throw notFound(uuid);
    return updated;
  }

  // EL ÚLTIMO PROPIO ACTIVO DE UN PROVEEDOR EN `own` NO SE DA DE BAJA: dejaría su catálogo vacío, o
  // sea al proveedor sin lobby. Es la otra mitad de la regla de `setCatalogSource` (pasar a `own` exige
  // un propio activo), y corre en el mismo turno del lease y la cola, así que una baja y un cambio de
  // fuente no se cruzan. Primero se vuelve a `shared`, después se da de baja.
  private async refuseEmptyingOwnCatalog(current: GameMode): Promise<void> {
    const owner = current.ownerProviderId;
    if (owner === null || !current.isActive) return;
    if ((await this.catalogs.of(owner)).source !== "own") return;
    const others = (await this.repository.active()).some(
      (mode) => mode.ownerProviderId === owner && mode.uuid !== current.uuid,
    );
    if (!others) {
      throw new GameModeStateConflictError(
        `el modo ${current.uuid} es el último propio activo de ${owner}, que juega sólo con sus propios (fuente own): primero volvé la fuente a shared`,
      );
    }
  }

  // EL MODO QUE ESTE ACTOR PUEDE EDITAR, DAR DE BAJA O REACTIVAR: las reglas 1 y 2 de arriba.
  private async editable(actor: CatalogActor, uuid: string): Promise<GameMode> {
    const mode = await this.found(uuid);
    if (actor.provider === null || mode.ownerProviderId === actor.provider) return mode;
    if (mode.ownerProviderId !== null) throw notFound(uuid);
    throw new GameModeForbiddenError("un modo compartido lo administra Betaso Games");
  }

  // TODA LA LISTA Y UN FILTRO, y no una consulta por nombre. El puerto no tiene `byName` a propósito
  // —agregárselo obliga a los dos adaptadores y a su contrato— y el catálogo son decenas de modos.
  // ponytail: si algún día fueran miles, lo que cambia es el puerto (un `findOne` indexado del lado
  // de Mongo), no esta función.
  private async nameTakenBy(
    name: string,
    owner: string | null,
    extra: (mode: GameMode) => boolean,
  ): Promise<boolean> {
    // Sin filtro por `isActive`, igual que las dos consultas de v1: un modo dado de baja sigue
    // ocupando su nombre, porque reactivarlo es una operación de un click y ahí aparecería el par
    // repetido.
    return (await this.repository.all()).some(
      (mode) => mode.ownerProviderId === owner && mode.name === name && extra(mode),
    );
  }

  private async found(uuid: string): Promise<GameMode> {
    const mode = await this.repository.byUuid(uuid);
    // `byUuid` y no `activeByUuid`: el panel edita y reactiva modos dados de baja, y buscarlos con
    // el filtro de activos convertiría toda reactivación en un 404.
    if (!mode) throw notFound(uuid);
    return mode;
  }

  // NO HAY DIFF: el repositorio incrementa `__v` en TODA llamada que encuentre el documento, incluso
  // una cuyo `$set` no cambie nada, igual que v1 (`game-mode.service.ts:110-123`).
  private async write(uuid: string, changes: UpdateGameMode): Promise<GameMode> {
    const updated = await this.repository.update(uuid, changes);
    // Inalcanzable hoy —la cola y el lease dejan una sola escritura por vez, y `found` ya leyó el
    // modo—, pero el puerto promete `GameMode | undefined` y tragarse el `undefined` con un `as`
    // sería prometer por él.
    if (!updated) throw notFound(uuid);
    return updated;
  }

  private mutating<T>(work: () => Promise<T>): Promise<T> {
    return this.queued(async () => {
      const done = await this.lease.within(CATALOG_LEASE, LEASE_TTL_MS, work);
      // `undefined` ES "NO LO CONSEGUÍ" y es un desenlace NORMAL: lo tiene otro proceso. Sale como
      // 503 y no como 500 —nadie hizo nada mal y reintentar es la respuesta correcta—. El precio del
      // contrato está escrito en `shared/mongo-lease.ts`: un `work()` que devolviera `undefined` de
      // verdad no se distinguiría, y ninguna de estas operaciones lo hace.
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

// LA REGLA 3 en una línea: un proveedor actúa sólo sobre sí mismo; Betaso Games, sobre cualquiera.
function refuseForeign(actor: CatalogActor, providerId: string, message: string): void {
  if (actor.provider !== null && actor.provider !== providerId) {
    throw new GameModeForbiddenError(message);
  }
}

function notFound(uuid: string): GameModeNotFoundError {
  return new GameModeNotFoundError(`no existe el modo ${uuid}`);
}

// EL DUEÑO DE UN MODO NUEVO (regla 3). Un proveedor: el suyo, mande o no el campo; otro —o `null`, que
// es pedir un compartido— es 403. Betaso Games: el que nombre, o compartido.
function ownerFor(actor: CatalogActor, requested: string | null | undefined): string | null {
  if (actor.provider === null) return requested ?? null;
  if (requested === undefined || requested === actor.provider) return actor.provider;
  throw new GameModeForbiddenError("un proveedor sólo crea modos propios suyos");
}

// LA COPIA: los mismos números y niveles que el compartido, con el proveedor de dueño. Campo por campo
// y no un spread del modo: la identidad, las fechas, la revisión y los suscriptores del origen no son
// de la copia.
function copyOf(source: GameMode, providerId: string): CreateGameMode {
  return {
    name: source.name,
    multiplier: source.multiplier,
    prize: source.prize,
    entryFee: source.entryFee,
    playersQuantity: source.playersQuantity,
    pointsToWin: source.pointsToWin,
    isFreeRoom: source.isFreeRoom,
    enableBots: source.enableBots,
    betLevels: source.betLevels,
    ownerProviderId: providerId,
  };
}
