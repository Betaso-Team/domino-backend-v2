// La entidad PORTABLE del catálogo: lo que el resto del sistema nombra cuando dice "un modo
// de juego". No es el documento BSON —ese vive adentro del adaptador Mongo (Tarea 4) y trae
// `_id` y `__v`—, ni el DTO HTTP —que reconstruye esos dos nombres para el panel de v1—.
// El core no sabe de Mongo, así que acá `_id` se llama `id` y `__v` se llama `version`: un
// core que nombra los campos de su base es un core que no se puede reemplazar de base.
export interface GameMode {
  // El hex del `_id` de Mongo, ya convertido a string por el adaptador. Es identidad de
  // ALMACENAMIENTO: lo consume el DTO HTTP, que debe devolver `_id` porque el panel de v1 lo
  // recibía.
  readonly id: string;
  // El identificador LÓGICO, generado con UUID v4. Es el que viaja por la ruta HTTP
  // (`/game-modes/:uuid`) y el que nombra el request que sienta una mesa.
  readonly uuid: string;
  readonly name: string;
  readonly multiplier: number;
  // Los importes son UC COMPLETAS y pueden tener decimales: `entryFee: 10` son diez UC, y un
  // modo productivo con `1.5` es un UC y medio de punta a punta. La Tarea 1 de este mismo
  // incremento sacó el sufijo `*UcMinor` justamente para que copiar estos números del catálogo
  // de v1 no invitara a un `* 100` en una sola de las dos puntas.
  readonly prize: number;
  readonly entryFee: number;
  // Angosto a propósito, aunque Mongo guarde un `number`: son los dos únicos valores que el
  // catálogo de v1 acepta, y el `2 | 4` es lo que obliga a un `switch` exhaustivo el día que
  // el motor de cuatro se abra. La coerción del `"2"` que Mongoose hacía vive en la frontera
  // HTTP (Tarea 9), no acá.
  readonly playersQuantity: 2 | 4;
  readonly pointsToWin: number;
  readonly isActive: boolean;
  // Se conservan, se validan y se exponen por HTTP, pero NO activan nada en este incremento:
  // no hay bots ni salas gratis todavía. Están en la entidad porque el documento productivo
  // los tiene y perderlos en un round-trip sería una migración destructiva encubierta.
  readonly isFreeRoom: boolean;
  readonly enableBots: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  // El `__v` de Mongoose. Se conserva porque el panel de v1 lo recibe, y sirve como REVISIÓN:
  // avanza en toda edición, y dos mutaciones del mismo milisegundo se distinguen —cosa que
  // `updatedAt` no puede.
  readonly version: number;
}

// Los campos que el repositorio sabe completar solo. Están en una unión con nombre y no
// repetidos en los dos `Omit`/`Pick` de abajo porque la lista tiene que ser UNA: si un campo
// se agrega al default y se olvida en el otro lado, el tipo queda pidiendo un valor que el
// llamador no tiene por qué conocer.
type DefaultedGameModeFields = "multiplier" | "pointsToWin" | "isFreeRoom" | "enableBots";

// Lo que hace falta para CREAR un modo. Fuera quedan la identidad (`id`/`uuid`), las fechas y
// la revisión —los pone el repositorio—, `isActive` —un modo nace activo; darlo de baja es
// otra operación— y los cuatro defaulteables, que vuelven como opcionales.
export type CreateGameMode = Omit<
  GameMode,
  "id" | "uuid" | "createdAt" | "updatedAt" | "version" | "isActive" | DefaultedGameModeFields
> &
  Partial<Pick<GameMode, DefaultedGameModeFields>>;

// Lo que se puede EDITAR. Todo opcional y todo por separado: un campo ausente no se toca, que
// es la diferencia entre un `PUT` parcial y un borrado silencioso de los campos que el panel
// no mandó. `isActive` sí entra —la baja y la reactivación son ediciones de ese booleano, no
// claves de evento propias— y la identidad, las fechas y la revisión no.
export type UpdateGameMode = Partial<
  Pick<
    GameMode,
    | "name"
    | "multiplier"
    | "prize"
    | "entryFee"
    | "playersQuantity"
    | "pointsToWin"
    | "isActive"
    | "isFreeRoom"
    | "enableBots"
  >
>;
