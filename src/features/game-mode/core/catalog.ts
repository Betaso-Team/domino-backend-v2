import type { CreateGameMode, GameMode, UpdateGameMode } from "./game-mode";

// El puerto de LECTURA, separado del de escritura y no por simetría: sus consumidores son
// distintos y sus permisos también. Los GET del catálogo son públicos y el nacimiento de una
// mesa resuelve el modo activo; ninguno de los dos puede crear ni editar, y un tipo que no
// expone `create` es más barato de auditar que una convención de que nadie lo llame.
export interface GameModeReader {
  // `active()` es lo que ve el jugador; `all()` es lo que ve el panel —incluye los dados de
  // baja, porque reactivarlos exige poder listarlos primero—. El orden (recientes primero) lo
  // fija el adaptador: es una propiedad de la consulta, no del contrato.
  active(): Promise<readonly GameMode[]>;
  all(): Promise<readonly GameMode[]>;
  // Mismo par por identificador lógico. `activeByUuid` devuelve `undefined` para un modo
  // inactivo: desde afuera, un modo dado de baja NO EXISTE, y esa es la diferencia que evita
  // que una mesa nazca con un modo retirado.
  activeByUuid(uuid: string): Promise<GameMode | undefined>;
  byUuid(uuid: string): Promise<GameMode | undefined>;
}

// La escritura EXTIENDE la lectura porque toda mutación necesita leer antes (la regla de no
// repetir `name + playersQuantity` de v1 es una consulta), y porque el adaptador es uno solo:
// partirlos en dos implementaciones sobre la misma colección duplicaría el mapeo BSON.
export interface GameModeRepository extends GameModeReader {
  create(input: CreateGameMode): Promise<GameMode>;
  // `undefined` y no un throw: "no existe" es una respuesta esperable de un `PUT` sobre un
  // uuid que el panel tiene cacheado, y la frontera HTTP la convierte en 404. El throw queda
  // para lo que el llamador no puede prever.
  update(uuid: string, input: UpdateGameMode): Promise<GameMode | undefined>;

  // CREA CON UN UUID DADO, O DEVUELVE EL QUE YA ESTABA con ese uuid, sin tocarlo. Es la escritura de
  // la copia de los compartidos a un operador (`createCopies`): el uuid es determinista, así que un
  // reintento después de una copia a medias completa lo que faltó y no duplica nada. `created` dice
  // cuál de las dos pasó. Lo que había NO se pisa: el operador puede haber editado su copia.
  insertIfAbsent(
    uuid: string,
    input: CreateGameMode,
  ): Promise<{ readonly mode: GameMode; readonly created: boolean }>;

  // LAS DOS ESCRITURAS DE LOS SUSCRIPTORES, sólo sobre modos COMPARTIDOS (`ownerProviderId` nulo).
  //
  // NINGUNA AVANZA LA REVISIÓN (`version`/`__v`) NI LA FECHA DE EDICIÓN: quién juega un modo no es
  // una edición del modo, y la revisión y la fecha son lo que el panel muestra como «editado».
  // `undefined` si no hay un compartido con ese uuid.
  addSubscriber(uuid: string, providerId: string): Promise<GameMode | undefined>;
  removeSubscriber(uuid: string, providerId: string): Promise<GameMode | undefined>;
}

// QUIÉN PIDE, para el ámbito: `provider` nulo es Betaso Games, que ve y toca todo; un id es un admin
// de ese operador. Es la mitad del `Admin` de `shared/http/api-key.ts` que el catálogo necesita, y se
// redeclara acá para que el core no dependa de la frontera HTTP (el tipado estructural las une).
export interface CatalogActor {
  readonly provider: string | null;
}

export const BETASO_GAMES: CatalogActor = { provider: null };

// QUÉ MODOS VE UN OPERADOR: los suyos, y los compartidos que lo tienen en la lista de suscriptores
// (explícita: sin lista, nadie). Betaso Games los ve todos. Es una regla de lectura y la comparten el
// listado del panel, la búsqueda de un modo y la copia de los compartidos.
export function offeredTo(mode: GameMode, provider: string): boolean {
  if (mode.ownerProviderId !== null) return mode.ownerProviderId === provider;
  return mode.subscribers.includes(provider);
}

export function visibleTo(mode: GameMode, actor: CatalogActor): boolean {
  return actor.provider === null || offeredTo(mode, actor.provider);
}

// Los CINCO errores de APLICACIÓN del catálogo. Son cinco y no uno porque un solo error con un
// campo `kind` adentro obliga a un `switch` en cada `catch` en vez de a cinco `catch` que el
// compilador ya distingue. `override readonly name` es la convención del repo: sin él,
// `instanceof` sigue funcionando pero el log dice "Error" y el que audita no sabe cuál fue.
//
// Eran TRES hasta la Tarea 8, y el cuarto no es un refinamiento sino una rama que v1 ya tenía y
// ningún error de acá podía expresar: «el modo ya está inactivo»/«ya está activo». Ver
// `GameModeStateConflictError`.
export class GameModeNotFoundError extends Error {
  override readonly name = "GameModeNotFoundError";
}

// La regla lógica de v1: no repetir `name + playersQuantity`. Es de aplicación y no de índice
// —el índice de v1 no la impone— y por eso tiene su propio error en vez de un `E11000` que
// solo el adaptador sabe leer.
export class DuplicateGameModeError extends Error {
  override readonly name = "DuplicateGameModeError";
}

// LA BAJA DE UN MODO YA INACTIVO, O LA REACTIVACIÓN DE UNO YA ACTIVO. Es el error que v1 lanzaba
// con `El modo ya está inactivo` / `El modo ya está activo`
// (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:148-150` y `:203-205`), y no lo puede
// cubrir ninguno de los otros tres:
//
// - `GameModeNotFoundError` diría 404, o sea "ese modo no existe", sobre un modo que el panel está
//   viendo listado en ese mismo momento. El operador iría a buscar un uuid equivocado.
// - `DuplicateGameModeError` comparte el código HTTP (409, porque también es un conflicto con el
//   estado actual) pero NO la causa, y el nombre es lo que se lee en el log: "Duplicate" mandaría a
//   auditar la regla de nombre + cantidad, que acá no intervino.
//
// La alternativa era volver idempotentes la baja y la reactivación —contestar 200 sin escribir—, y
// se descartó: la baja de un modo con dinero configurado es una operación que el panel tiene que
// poder confirmar que hizo ÉL, y un 200 silencioso sobre un modo que otro admin ya retiró es
// exactamente el aviso que se pierde.
export class GameModeStateConflictError extends Error {
  override readonly name = "GameModeStateConflictError";
}

// UNA MESA GRATIS QUE COBRA ENTRADA (truco `a876258`). En el dominó `isFreeRoom` es un campo propio
// y no se deriva de la entrada —v1 decide «gratis» por la bandera—, así que el panel puede mandar los
// dos contradiciéndose: la mesa apaga el aumento y reporta gratis mientras la entrada sigue cargada.
// Es plata, así que se rechaza en vez de elegir uno de los dos. 400 y no 409: lo que está mal es el
// pedido, no un choque con el estado.
export class FreeRoomWithEntryError extends Error {
  override readonly name = "FreeRoomWithEntryError";
}

// La escritura no pudo TOMAR SU TURNO: otro proceso tiene el lease que serializa las
// mutaciones. Es distinto de un duplicado y de una caída de Mongo: nadie hizo nada mal y
// reintentar es la respuesta correcta, así que la frontera contesta 503 y no 409 ni 500.
export class GameModeWriteBusyError extends Error {
  override readonly name = "GameModeWriteBusyError";
}

// UN OPERADOR PIDIENDO ALGO QUE NO ES SUYO: editar un compartido —que no es secreto, lo lista el
// catálogo público—, crear un modo para otro operador, suscribir a otro. 403. Un modo PROPIO de otro
// operador no llega acá: sale como «no existe» (404), porque decir 403 le confirmaría que existe.
export class GameModeForbiddenError extends Error {
  override readonly name = "GameModeForbiddenError";
}

// ── LA FUENTE DEL CATÁLOGO DE CADA OPERADOR ───────────────────────────────────────────────────────
//
// QUÉ CATÁLOGO JUEGA UN OPERADOR, entero y no modo a modo: `shared` es el compartido —los
// compartidos activos a los que está suscrito—, `own` son sólo sus modos propios activos. Quien
// arma el catálogo efectivo es el orquestador (que además sabe si el operador juega contra todos,
// en cuyo caso siempre usa el compartido); acá vive la elección porque el dominó es el dueño de los
// modos. Un operador sin registro está en `shared`, y es el reposo: nadie queda sin lobby por no
// haber elegido.
export type CatalogSource = "shared" | "own";

export const DEFAULT_CATALOG_SOURCE: CatalogSource = "shared";

export interface ProviderCatalog {
  readonly providerId: string;
  readonly source: CatalogSource;
  // Quién la cambió por última vez y cuándo; `null` en un operador que nunca la cambió.
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

// EL PUERTO DE LAS FUENTES. `of` nunca devuelve `undefined`: un operador sin registro tiene la fuente
// por default. `nonShared` es lo que lee el orquestador: sólo los que se apartan del default, porque
// el resto —la inmensa mayoría— no necesita viajar.
export interface ProviderCatalogRepository {
  of(providerId: string): Promise<ProviderCatalog>;
  nonShared(): Promise<readonly ProviderCatalog[]>;
  set(providerId: string, source: CatalogSource, updatedBy: string): Promise<ProviderCatalog>;
}

export function defaultCatalogOf(providerId: string): ProviderCatalog {
  return { providerId, source: DEFAULT_CATALOG_SOURCE, updatedAt: null, updatedBy: null };
}
