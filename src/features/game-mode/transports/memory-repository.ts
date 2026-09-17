import { randomBytes, randomUUID } from "node:crypto";
import type { GameModeRepository } from "../core/catalog.js";
import type { CreateGameMode, GameMode, UpdateGameMode } from "../core/game-mode.js";
import type { Clock } from "./mongo-repository.js";

// EL CATÁLOGO DE LA INSTANCIA QUE NO TIENE MONGO, y NO un doble de test. Es la misma decisión que
// `MemoryHistory`: la presencia de `MONGO_URI` elige, y sin ella el proceso levanta igual y el
// catálogo vive en memoria. Por eso no se llama "fake" — un fake es algo que sólo existe en la
// suite, y esto se despliega.
//
// Lo que se pierde es la persistencia y nada más: los defaults, el orden y la revisión son los
// MISMOS que los del adaptador Mongo, y lo mide el contrato compartido
// (`tests/repository-contract.ts`) corriendo contra los dos. Si acá el catálogo saliera en otro
// orden, la suite estaría certificando un comportamiento que la producción no tiene.

export class MemoryGameModeRepository implements GameModeRepository {
  // EN ORDEN DE INSERCIÓN, y el orden de salida se calcula al leer. Guardarlos ya ordenados
  // obligaría a reordenar en cada escritura para una lectura que igual tiene que filtrar.
  private readonly modes: GameMode[] = [];

  constructor(private readonly clock: Clock) {}

  async create(input: CreateGameMode): Promise<GameMode> {
    const now = new Date(this.clock.now());
    // Los defaults están duplicados con los del adaptador Mongo y eso es DELIBERADO: extraerlos a
    // una función compartida los volvería un dato que ninguno de los dos adaptadores declara, y el
    // documento BSON —que es la razón de existir del otro— dejaría de leerse completo en un solo
    // archivo. Lo que impide que deriven no es la extracción, es el contrato que los mide a los dos.
    const mode: GameMode = {
      // Doce bytes en hex, que es la forma de un `ObjectId`. La frontera HTTP devuelve este campo
      // como `_id` porque el panel de v1 lo recibía así: un `mode-1` sería un identificador que un
      // panel que valide la forma rechaza.
      id: randomBytes(12).toString("hex"),
      uuid: randomUUID(),
      name: input.name,
      multiplier: input.multiplier ?? 1,
      prize: input.prize,
      entryFee: input.entryFee,
      playersQuantity: input.playersQuantity,
      pointsToWin: input.pointsToWin ?? 25,
      isActive: true,
      isFreeRoom: input.isFreeRoom ?? false,
      // Con `??` y no con `||`, igual que el adaptador Mongo: un `enableBots: false` explícito
      // sobre una mesa de cuatro es una elección, y `||` la pisaría con el default.
      enableBots: input.enableBots ?? input.playersQuantity === 4,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    this.modes.push(mode);
    return { ...mode };
  }

  async update(uuid: string, input: UpdateGameMode): Promise<GameMode | undefined> {
    const index = this.modes.findIndex((mode) => mode.uuid === uuid);
    if (index < 0) return undefined;
    const current = this.modes[index] as GameMode;
    const updated: GameMode = {
      ...current,
      // `definedOf` y no `...input` a secas: un `{ name: undefined }` explícito es una clave
      // presente en JavaScript, así que el spread lo escribiría encima del nombre que había. Es la
      // misma trampa que del lado de Mongo, donde termina siendo un `null` en la base.
      ...definedOf(input),
      updatedAt: new Date(this.clock.now()),
      // LA REVISIÓN AVANZA DESDE LA REVISIÓN, no desde el reloj: dos ediciones del mismo
      // milisegundo tienen que dar 1 y 2, y con el reloj colapsarían en la misma.
      version: current.version + 1,
    };
    this.modes[index] = updated;
    return { ...updated };
  }

  async active(): Promise<readonly GameMode[]> {
    return this.newestFirst(this.modes.filter((mode) => mode.isActive));
  }

  async all(): Promise<readonly GameMode[]> {
    return this.newestFirst(this.modes);
  }

  // El `isActive` va en la búsqueda y no después: desde afuera, un modo dado de baja NO EXISTE.
  async activeByUuid(uuid: string): Promise<GameMode | undefined> {
    return this.found((mode) => mode.uuid === uuid && mode.isActive);
  }

  async byUuid(uuid: string): Promise<GameMode | undefined> {
    return this.found((mode) => mode.uuid === uuid);
  }

  // RECIENTES PRIMERO, el mismo orden que el `sort({ createdAt: -1 })` del adaptador Mongo. El
  // `sort` de JavaScript es estable, así que dos modos creados en el mismo milisegundo salen en
  // orden de inserción — Mongo no promete nada para el empate, y prometer menos acá sería prometer
  // algo que el otro adaptador no puede cumplir.
  //
  // Se copia cada modo al salir: quien reciba uno y lo mute cambiaría el catálogo de todos sin
  // pasar por `update`, o sea sin avanzar la revisión.
  private newestFirst(modes: readonly GameMode[]): readonly GameMode[] {
    return [...modes]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((mode) => ({ ...mode }));
  }

  private found(predicate: (mode: GameMode) => boolean): GameMode | undefined {
    const mode = this.modes.find(predicate);
    return mode ? { ...mode } : undefined;
  }
}

function definedOf(input: UpdateGameMode): Partial<GameMode> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) changes[key] = value;
  }
  return changes as Partial<GameMode>;
}
