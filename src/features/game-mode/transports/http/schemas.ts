import { z } from "zod";
import type { CreateGameMode, GameMode, UpdateGameMode } from "../../core/game-mode.js";

// LA FRONTERA DE FORMA DEL CATÁLOGO: lo que entra por HTTP y lo que sale. No hay routing acá —eso es
// `register-http.ts`— y no hay reglas de negocio: qué cuenta como duplicado o qué se puede reactivar
// lo decide el servicio.
//
// ESTE ARCHIVO ES LO QUE v1 NO TENÍA. Su DTO zod existe (`Betaso-Domino-Backend/src/game-modes/dto/
// game-mode.dto.ts`) y es CÓDIGO MUERTO: las rutas desestructuran `req.body` crudo y nunca llaman
// `.parse()` (`routes.ts:92-93` y `:117-118`), así que lo único que validaba era Mongoose, después
// de la consulta de duplicados y con el resultado saliendo como 500. Acá el cuerpo se parsea ANTES
// de tocar la base, y lo que el schema no deja pasar no llega al servicio.

// EL TECHO DE MAGNITUD DE LOS IMPORTES, y es la misma guarda que `configOf` (Tarea 1). Sin él,
// `2 ** 53` es una inscripción válida — y arriba de `Number.MAX_SAFE_INTEGER` dos importes DISTINTOS
// son el mismo `number`, o sea dos precios que el panel cree haber configurado distinto y se cobran
// igual. **No se escribe `.safe()`**: en zod 4 implica ENTERO y rechazaría el `1.5`, que es un UC y
// medio y es un monto legítimo desde que la Tarea 1 sacó el sufijo `*UcMinor`.
//
// El snippet del plan escribía `z.number().finite().nonnegative()` a secas: es el agujero que la
// Tarea 1 acababa de cerrar, reabierto en la otra punta del mismo incremento.
const ucAmount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

// LOS CAMPOS SIN DEFAULT, declarados UNA vez. El cuerpo de creación los envuelve con los defaults del
// schema productivo y el de edición los vuelve opcionales; escribir las dos listas por separado es la
// forma de que un campo nuevo entre en una y no en la otra.
const fields = {
  name: z.string().min(1),
  // `min(1)` es el del schema de v1 (`game-mode.schema.ts:30-35`). No lleva techo porque no es un
  // importe: no se suma ni se compara con otro monto, y hoy nada del motor lo multiplica.
  multiplier: z.number().finite().min(1),
  prize: ucAmount,
  entryFee: ucAmount,
  // LAS CUATRO FORMAS, y las dos de string no son un capricho: Mongoose coercionaba el `"2"` y el
  // DTO histórico declaraba `z.enum(["2","4"])`, así que el panel productivo puede estar mandando
  // cualquiera de las dos. Rechazar el string acá rompería al cliente que hoy funciona.
  //
  // El `.transform(Number)` del plan devuelve `number` y NO `2 | 4`, así que no compila contra
  // `CreateGameMode` —y el gate de este repo es `typecheck`, no el verde de vitest—. El transform
  // decide por valor y no castea: un `as 2 | 4` prometería por el schema.
  playersQuantity: z
    .union([z.literal(2), z.literal(4), z.literal("2"), z.literal("4")])
    .transform((value): 2 | 4 => (value === 2 || value === "2" ? 2 : 4)),
  // `max(100)` es el del schema de v1 (`:51-56`). El default es el 25 del SCHEMA y no el 10 del DTO
  // muerto: los documentos productivos tienen 25.
  pointsToWin: z.number().finite().max(100),
  isActive: z.boolean(),
  isFreeRoom: z.boolean(),
  enableBots: z.boolean(),
};

// `strictObject` EN LAS DOS PUNTAS: lo que el catálogo no conoce se contesta 400 en vez de guardarse
// a medias. Mongoose descartaba los campos de más en silencio, así que un panel que mandara
// `entry_fee` creaba un modo con la inscripción en cero y nadie se enteraba.
export const CREATE_BODY = z.strictObject({
  name: fields.name,
  multiplier: fields.multiplier.default(1),
  prize: fields.prize,
  entryFee: fields.entryFee,
  playersQuantity: fields.playersQuantity,
  pointsToWin: fields.pointsToWin.default(25),
  // SE ACEPTA Y SE IGNORA, igual que v1: el panel histórico lo manda y el servicio lo pisa con `true`
  // (`game-mode.service.ts:64-69`, el `isActive: true` va DESPUÉS del spread del cuerpo). Un modo
  // nace activo; darlo de baja es otra operación, con su propia ruta y su propio evento. Se declara
  // igual porque `strictObject` lo rechazaría, y un 400 sobre un cuerpo que v1 acepta es una ruptura.
  isActive: z.boolean().default(true),
  isFreeRoom: fields.isFreeRoom.default(false),
  // EL ÚNICO SIN DEFAULT ACÁ, porque el suyo depende de otro campo: `playersQuantity === 4`
  // (`game-mode.schema.ts:66-71`). Lo completa el repositorio, que es quien lo tiene escrito para los
  // dos adaptadores; ponerle un default fijo acá lo apagaría en toda mesa de cuatro.
  enableBots: fields.enableBots.optional(),
});

// ⚠ NO ES `CREATE_BODY.partial()`, Y ESA ES LA LÍNEA MÁS IMPORTANTE DEL ARCHIVO. Medido sobre la zod
// 4 instalada: `.partial()` deja los defaults VIVOS —`z.strictObject({ m: z.number().default(1) })
// .partial().parse({})` devuelve `{ m: 1 }`—, así que un `PUT` que sólo cambia el premio le
// reescribiría al modo el multiplicador, los puntos y la sala gratis con los valores de fábrica.
// Sobre un catálogo que configura dinero real eso es una edición destructiva que nadie pidió y que
// ninguna respuesta de error señala. El plan pedía `.partial()` "sin aplicar defaults"; las dos
// mitades de esa frase son incompatibles en zod, así que los campos se vuelven a listar sin envolver.
//
// `isActive` SÍ entra: la baja y la reactivación tienen ruta propia, pero v1 también lo deja editar
// por `PUT` (`routes.ts:117-118`) y quitarlo rompería al panel que hoy lo manda.
export const UPDATE_BODY = z.strictObject({
  name: fields.name.optional(),
  multiplier: fields.multiplier.optional(),
  prize: fields.prize.optional(),
  entryFee: fields.entryFee.optional(),
  playersQuantity: fields.playersQuantity.optional(),
  pointsToWin: fields.pointsToWin.optional(),
  isActive: fields.isActive.optional(),
  isFreeRoom: fields.isFreeRoom.optional(),
  enableBots: fields.enableBots.optional(),
});

// EL IDENTIFICADOR DE LA RUTA, y NO SE EXIGE FORMA DE UUID aunque los nuestros lo sean. El DTO de v1
// declaraba `z.string().uuid()` y nunca corrió, así que ninguna ruta productiva lo impuso: clavarlo
// acá convertiría en 400 el pedido por un identificador legítimo que el panel tenga guardado de
// antes, y rechazar lo bueno es peor que no validar.
//
// Lo que sí se corta son los CARACTERES DE CONTROL, por el mismo argumento que el `matchId` del
// historial (`features/match/transports/http/register-http.ts`): este valor entra del cliente y
// termina en el log del operador, y un `%0A` llega decodificado a `request.params` y parte la línea
// en dos. `\P{Cc}` es la categoría Unicode "Control" —cubre también los C1 y no mete controles
// literales en el fuente, que es lo que la regla `noControlCharactersInRegex` de biome prohíbe—.
export const UUID_PARAMS = z.object({
  uuid: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u, "uuid inválido"),
});

export type CreateBody = z.infer<typeof CREATE_BODY>;
export type UpdateBody = z.infer<typeof UPDATE_BODY>;

// EL DTO HISTÓRICO, con los catorce nombres que el panel de v1 recibe. Los dos que no existen en el
// core son los de Mongo: `_id` y `__v`. El core los llama `id` y `version` a propósito —un core que
// nombra los campos de su base es un core que no se puede cambiar de base—, así que la traducción
// vive acá, que es el único lugar que tiene que hablar el idioma del panel viejo.
//
// LAS FECHAS SALEN COMO `Date` y las serializa Express: `JSON.stringify` da el ISO 8601, que es
// exactamente lo que v1 devolvía al pasarle el documento de Mongoose a `res.json`.
export interface GameModeDTO {
  readonly _id: string;
  readonly uuid: string;
  readonly name: string;
  readonly multiplier: number;
  readonly prize: number;
  readonly entryFee: number;
  readonly playersQuantity: 2 | 4;
  readonly pointsToWin: number;
  readonly isActive: boolean;
  readonly isFreeRoom: boolean;
  readonly enableBots: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly __v: number;
}

// SE ESCRIBE CAMPO POR CAMPO Y NO CON UN SPREAD DEL MODO. Con `{ ...mode, _id: mode.id }` cualquier
// campo que el core agregue mañana sale publicado sin que nadie lo decida —y el core es justamente
// donde van a aparecer los campos internos—. Acá, un campo nuevo que tenga que viajar se agrega a
// mano, que es la decisión que se quiere obligar.
export function toDTO(mode: GameMode): GameModeDTO {
  return {
    _id: mode.id,
    uuid: mode.uuid,
    name: mode.name,
    multiplier: mode.multiplier,
    prize: mode.prize,
    entryFee: mode.entryFee,
    playersQuantity: mode.playersQuantity,
    pointsToWin: mode.pointsToWin,
    isActive: mode.isActive,
    isFreeRoom: mode.isFreeRoom,
    enableBots: mode.enableBots,
    createdAt: mode.createdAt,
    updatedAt: mode.updatedAt,
    __v: mode.version,
  };
}

// EL CUERPO PARSEADO → LA ENTRADA DEL CASO DE USO, y lo único que hace es SACAR `isActive`. La
// omisión no es cosmética: `CreateGameMode` no tiene ese campo, pero el chequeo de propiedades de más
// de TypeScript sólo corre sobre literales, así que pasar el objeto parseado entero compilaría y le
// entregaría al repositorio un `isActive` que el panel puede haber mandado en `false`.
export function createInputOf({ isActive: _isActive, ...input }: CreateBody): CreateGameMode {
  return input;
}

// El cuerpo de edición YA tiene la forma del caso de uso —mismos nombres, todos opcionales—, así que
// esto es una firma y no una conversión: existe para que el día que los dos tipos dejen de coincidir
// el error salga acá y no en el handler.
export function updateInputOf(input: UpdateBody): UpdateGameMode {
  return input;
}
