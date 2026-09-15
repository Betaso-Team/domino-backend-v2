import type { CreateGameMode, GameMode, UpdateGameMode } from "./game-mode.js";

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
}

// Los CUATRO errores de APLICACIÓN del catálogo. Son cuatro y no uno porque un solo error con un
// campo `kind` adentro obliga a un `switch` en cada `catch` en vez de a cuatro `catch` que el
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

// La escritura no pudo TOMAR SU TURNO: otro proceso tiene el lease que serializa las
// mutaciones. Es distinto de un duplicado y de una caída de Mongo: nadie hizo nada mal y
// reintentar es la respuesta correcta, así que la frontera contesta 503 y no 409 ni 500.
export class GameModeWriteBusyError extends Error {
  override readonly name = "GameModeWriteBusyError";
}
