import { randomUUID } from "node:crypto";
import type { Collection, Document, IndexDescription, ObjectId, WithId } from "mongodb";
import type { GameModeRepository } from "../core/catalog";
import type { CreateGameMode, GameMode, UpdateGameMode } from "../core/game-mode";

// EL CATÁLOGO PRODUCTIVO, LEÍDO Y ESCRITO SIN MONGOOSE. Domino v2 pasa a ser el ÚNICO escritor de
// una colección que hoy escribe v1 a través de un `mongoose.Schema`, así que el documento que sale
// de acá tiene que ser el mismo que salía de allá: mismos nombres, mismos defaults, mismo `__v`,
// mismos timestamps, mismos índices. Un campo que este adaptador se olvide es un campo que los
// lectores de v1 dejan de encontrar, y no falla nada de este lado.
//
// SIN MONGOOSE, y es una decisión y no una omisión: el repo ya tiene el driver oficial por la
// persistencia del historial, y traer una capa de modelos para UNA colección agregaría un
// pluralizador de nombres, un sistema de defaults y un ciclo de vida de conexión propios — tres
// cosas que hay que verificar contra lo que v1 dejó escrito en la base, que es exactamente lo que
// el driver pelado deja a la vista.

// LA COLECCIÓN, en una constante y no en una variable de entorno, por el mismo argumento que
// `HISTORY_COLLECTION`: acá el nombre no se puede elegir. Es el que v1 declaró explícitamente
// (`Betaso-Domino-Backend/src/storage/mongo/schemas/game-mode.schema.ts:74`), y apuntar a otro sería
// un catálogo vacío que se descubre cuando un jugador no encuentra mesas.
export const GAME_MODE_COLLECTION = "game_modes_domino";

// LO MÍNIMO QUE ESTE ADAPTADOR NECESITA de la conexión, declarado como interfaz estructural y no
// como la clase `Mongo`. Es el mismo recorte que `HistoryStore`: `Mongo` la satisface sin saberlo,
// así que el cableado no cambia, y la suite le puede dar un doble sin un `as unknown as Mongo`.
//
// Se corta acá y no más abajo a propósito: `Collection<T>` sigue siendo el tipo del driver, que es
// lo que hace que `tsc` verifique el documento de update. Narrar a mano un `findOneAndUpdate`
// aflojaría justo lo único que el gate puede chequear.
export interface CollectionSource {
  collection<T extends Document>(name: string): Promise<Collection<T>>;
}

// EL RELOJ, redeclarado acá y no importado de `features/match`. La feature del match lo exporta por
// su `index.ts`, así que importarlo sería legal hoy (Regla 4) — y un ciclo mañana: la Tarea 12 hace
// que el nacimiento de una mesa resuelva el modo activo, o sea `match → game-mode`. Con el import
// puesto, `no-circular` se pondría rojo en esa tarea y el arreglo sería este mismo recorte, hecho
// con prisa. Es una interfaz de un método y el tipado estructural la une con la de allá sin que
// ninguna de las dos sepa de la otra.
export interface Clock {
  now(): number;
}

// LA FORMA DEL DOCUMENTO, declarada SÓLO ACÁ. El core nombra `id` y `version` porque un core que
// nombra los campos de su base es un core que no se puede reemplazar de base; `_id` y `__v` son de
// Mongo y no salen de este archivo.
//
// `_id` es opcional porque el insert NO lo manda: lo asigna la base y vuelve en `insertedId`.
// `__v` es el `versionKey` que Mongoose ponía en cero y nunca movía —no hay arreglos en este
// documento, así que ni `save()` ni `findOneAndUpdate` lo incrementaban—; v2 lo usa como REVISIÓN,
// que es un uso nuevo sobre un campo que ya estaba. Ver el `$inc` de `update`.
export interface GameModeDocument {
  _id?: ObjectId;
  uuid: string;
  name: string;
  multiplier: number;
  prize: number;
  entryFee: number;
  playersQuantity: 2 | 4;
  pointsToWin: number;
  isActive: boolean;
  isFreeRoom: boolean;
  enableBots: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

// LOS CUATRO ÍNDICES DE v1, con sus nombres escritos. Los tres primeros salen de las declaraciones
// del schema (`game-mode.schema.ts:20-25`, `:57-61` y `:78`) y el cuarto de `:79`; los nombres son
// los que Mongoose deriva de la clave, que es como están HOY en producción.
//
// Se nombran en vez de dejarlos derivar porque `createIndexes` es idempotente mientras nombre y
// clave coincidan: el mismo índice con otro nombre no se reconoce, se CREA otra vez. Y no se borra
// ni se renombra nada — un `dropIndex` durante el corte es una consulta del catálogo sin índice
// mientras se reconstruye.
const GAME_MODE_INDEXES: IndexDescription[] = [
  // `unique` porque el schema de v1 lo declara sobre `uuid`. La regla lógica de "no repetir
  // `name + playersQuantity`" NO es un índice —v1 la resuelve consultando antes de insertar
  // (`game-mode.service.ts:58`)— y por eso no aparece acá.
  { key: { uuid: 1 }, name: "uuid_1", unique: true },
  { key: { isActive: 1 }, name: "isActive_1" },
  { key: { isActive: 1, name: 1 }, name: "isActive_1_name_1" },
  { key: { isActive: 1, uuid: 1 }, name: "isActive_1_uuid_1" },
];

// RECIENTES PRIMERO, igual que los dos listados de v1 (`game-mode.service.ts:25` y `:36`). El orden
// lo fija el adaptador porque es una propiedad de la consulta y no del contrato, pero los DOS
// adaptadores fijan el mismo: el contrato compartido de `tests/repository-contract.ts` lo mide en
// los dos.
const NEWEST_FIRST = { createdAt: -1 } as const;

export class MongoGameModeRepository implements GameModeRepository {
  // La colección YA PREPARADA, memoizada. Los índices se crean una vez por proceso y no una vez por
  // consulta: el camino del lobby lee el catálogo seguido, y cuatro `createIndexes` por lectura son
  // cuatro round-trips para reconocer índices que ya están.
  private prepared?: Promise<Collection<GameModeDocument>>;

  constructor(
    private readonly source: CollectionSource,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateGameMode): Promise<GameMode> {
    const now = new Date(this.clock.now());
    // LOS DEFAULTS SON LOS DEL SCHEMA DE v1 y no los del DTO zod, que nunca se ejecutaba: las rutas
    // de v1 desestructuran `req.body` crudo y jamás llaman `CreateGameModeSchema.parse`, así que su
    // `pointsToWin` por default de 10 era código muerto y lo que los documentos productivos tienen
    // es el 25 del schema (`game-mode.schema.ts:51-56`).
    const document: GameModeDocument = {
      // `randomUUID()` de node y no el paquete `uuid` que usa v1: es la misma v4 y es del runtime.
      uuid: randomUUID(),
      name: input.name,
      multiplier: input.multiplier ?? 1,
      // Los importes son UC COMPLETAS y se guardan tal cual, decimales incluidos. No hay escala en
      // ninguna de las dos direcciones — es la corrección de la Tarea 1 llevada hasta la base.
      prize: input.prize,
      entryFee: input.entryFee,
      playersQuantity: input.playersQuantity,
      pointsToWin: input.pointsToWin ?? 25,
      // Un modo NACE ACTIVO; darlo de baja es otra operación, y por eso `isActive` no está en
      // `CreateGameMode`.
      isActive: true,
      isFreeRoom: input.isFreeRoom ?? false,
      // EL ÚNICO DEFAULT QUE DEPENDE DE OTRO CAMPO, y está copiado de la función que v1 declara en
      // el schema (`game-mode.schema.ts:66-71`, `default() { return this.playersQuantity === 4 }`).
      // Con `??` y no con `||`: un `enableBots: false` explícito sobre una mesa de cuatro es una
      // elección del panel, y `||` la pisaría con el default.
      enableBots: input.enableBots ?? input.playersQuantity === 4,
      // `createdAt`/`updatedAt` los ponía el `timestamps: true` de Mongoose. Acá los pone el
      // repositorio desde el reloj INYECTADO —no `new Date()` directo—, que es lo que hace que el
      // contrato pueda medir dos ediciones dentro del mismo milisegundo.
      createdAt: now,
      updatedAt: now,
      __v: 0,
    };
    const { insertedId } = await (await this.collection()).insertOne(document);
    return modeOf({ ...document, _id: insertedId });
  }

  async update(uuid: string, input: UpdateGameMode): Promise<GameMode | undefined> {
    const updated = await (await this.collection()).findOneAndUpdate(
      { uuid },
      {
        // SÓLO LAS CLAVES QUE EL LLAMADOR MANDÓ, más la fecha. Un `$set` armado con
        // `{ ...input }` a secas mete `name: undefined` para los campos ausentes, y el driver lo
        // escribe como `null`: sería un `PUT` parcial borrando en silencio todo lo que el panel no
        // completó.
        $set: { ...definedOf(input), updatedAt: new Date(this.clock.now()) },
        // LA REVISIÓN ES UN `$inc` DE LA BASE, y es la línea que no se puede escribir de otra
        // forma. Derivarla del reloj colapsaría dos ediciones del mismo milisegundo en la misma
        // revisión; calcularla en el proceso (`leído + 1`) colapsaría dos ediciones concurrentes.
        // El outbox deduplica por `uuid + version`, así que dos cambios reales con la misma
        // revisión son UN evento publicado y otro DESCARTADO EN SILENCIO — el consumidor se queda
        // con el catálogo viejo y nadie ve un error.
        $inc: { __v: 1 },
      },
      // `after` porque lo que se devuelve es el modo YA EDITADO: quien llama publica el evento con
      // ese cuerpo, y el default del driver (`before`) publicaría el estado anterior con la
      // revisión anterior.
      { returnDocument: "after" },
    );
    // `undefined` y no un throw: "no existe" es una respuesta esperable de un `PUT` sobre un uuid
    // que el panel tiene cacheado, y la frontera HTTP la convierte en 404.
    return updated ? modeOf(updated) : undefined;
  }

  async active(): Promise<readonly GameMode[]> {
    return this.list({ isActive: true });
  }

  async all(): Promise<readonly GameMode[]> {
    return this.list({});
  }

  // DESDE AFUERA, UN MODO DADO DE BAJA NO EXISTE: el filtro lleva el `isActive` adentro en vez de
  // leer y descartar después, igual que v1 (`game-mode.service.ts:47`). Es lo que impide que una
  // mesa nazca con un modo retirado.
  async activeByUuid(uuid: string): Promise<GameMode | undefined> {
    return this.one({ uuid, isActive: true });
  }

  async byUuid(uuid: string): Promise<GameMode | undefined> {
    return this.one({ uuid });
  }

  private async list(filter: Partial<GameModeDocument>): Promise<readonly GameMode[]> {
    const found = await (await this.collection()).find(filter).sort(NEWEST_FIRST).toArray();
    return found.map(modeOf);
  }

  private async one(filter: Partial<GameModeDocument>): Promise<GameMode | undefined> {
    const found = await (await this.collection()).findOne(filter);
    return found ? modeOf(found) : undefined;
  }

  // LA COLECCIÓN LISTA, con los índices ya pedidos. El memo guarda la PROMESA, así que veinte
  // consultas concurrentes al arrancar comparten un solo `createIndexes` en vez de disparar veinte.
  private collection(): Promise<Collection<GameModeDocument>> {
    this.prepared ??= this.prepare().catch((error: unknown) => {
      // Se limpia al fallar, igual que el `finally` de `Mongo.ready()`: sin esto, un Mongo que
      // todavía no había levantado deja al catálogo pegado a una promesa rechazada hasta que
      // alguien reinicie el proceso.
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  private async prepare(): Promise<Collection<GameModeDocument>> {
    const collection = await this.source.collection<GameModeDocument>(GAME_MODE_COLLECTION);
    await collection.createIndexes(GAME_MODE_INDEXES);
    return collection;
  }
}

// EL MAPPER, y la única frontera entre los dos vocabularios. `_id` → `id` (hex, porque el DTO HTTP
// tiene que devolverlo y el panel de v1 lo recibía así) y `__v` → `version`.
//
// OJO con `id`: NO es el `id` del cuerpo Rabbit, que es el `uuid` (ver `events.ts`). Publicar el
// hex le crea al consumidor un registro nuevo por cada modo en vez de actualizar el que ya tiene,
// y nada falla de este lado.
function modeOf(document: WithId<GameModeDocument>): GameMode {
  return {
    id: document._id.toHexString(),
    uuid: document.uuid,
    name: document.name,
    multiplier: document.multiplier,
    prize: document.prize,
    entryFee: document.entryFee,
    playersQuantity: document.playersQuantity,
    pointsToWin: document.pointsToWin,
    isActive: document.isActive,
    isFreeRoom: document.isFreeRoom,
    enableBots: document.enableBots,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    version: document.__v,
  };
}

// Las claves con valor, para que un campo ausente no viaje como `undefined`. `Object.entries` ya
// omite las claves que no existen; lo que filtra este `if` es el `{ name: undefined }` explícito,
// que en JavaScript es una clave presente y para el driver es un `null` escrito encima.
function definedOf(input: UpdateGameMode): Partial<GameModeDocument> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) set[key] = value;
  }
  return set as Partial<GameModeDocument>;
}
