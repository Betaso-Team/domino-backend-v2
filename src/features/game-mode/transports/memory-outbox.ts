import { MemoryOutboxStore } from "@/shared/outbox";
import type { GameMode } from "../core/game-mode";
import {
  type GameModeEvent,
  type GameModeEventKey,
  type GameModePayload,
  createdEventOf,
  updatedEventOf,
} from "../events";
import {
  type Clock,
  type GameModeOutbox,
  type GameModeOutboxEntry,
  createdKeyOf,
  revisionKeysOf,
  syncKeyOf,
  updatedKeyOf,
} from "../outbox";

// EL OUTBOX DE LA INSTANCIA QUE NO TIENE MONGO, y NO un doble de test: es la misma decisión que
// `MemoryHistory` y `MemoryGameModeRepository`. La presencia de `MONGO_URI` elige, y sin ella el
// proceso levanta igual, el catálogo vive en memoria y sus eventos también. Por eso no se llama
// "fake" — un fake sólo existe en la suite, y esto se despliega.
//
// LO QUE SE PIERDE ES LA DURABILIDAD Y NADA MÁS: las claves de deduplicación, el orden de entrega, el
// no-adelantarse y la reconciliación son los MISMOS que los del adaptador Mongo, y lo mide el contrato
// compartido (`tests/outbox-contract.ts`) corriendo contra los dos. Si acá el orden fuera otro, la
// suite estaría certificando un comportamiento que la producción no tiene.

export class MemoryGameModeOutbox implements GameModeOutbox {
  // EL ALMACÉN COMPARTIDO: orden de inserción, deduplicación por clave y no-adelantarse. Lo que queda
  // acá son las claves del catálogo y la reconciliación.
  private readonly store: MemoryOutboxStore<GameModeEventKey, GameModePayload>;

  constructor(clock: Clock) {
    this.store = new MemoryOutboxStore(clock);
  }

  async enqueueCreated(mode: GameMode): Promise<void> {
    await this.insert(createdKeyOf(mode), createdEventOf(mode));
  }

  async ensureUpdated(mode: GameMode): Promise<void> {
    await this.insert(updatedKeyOf(mode), updatedEventOf(mode));
  }

  async sync(modes: readonly GameMode[], batchId: string): Promise<number> {
    for (const mode of modes) {
      await this.insert(syncKeyOf(batchId, mode), updatedEventOf(mode));
    }
    // LO QUE SE ENCOLÓ, que es lo que el `POST /sync` de v1 contesta como `synced`. No se cuentan los
    // insertados: repetir el mismo lote no duplica, y devolver menos haría que el operador creyera
    // que se perdieron modos.
    return modes.length;
  }

  async reconcile(modes: readonly GameMode[]): Promise<void> {
    const present = await this.store.present(modes.flatMap((mode) => revisionKeysOf(mode)));
    for (const mode of modes) {
      if (revisionKeysOf(mode).some((key) => present.has(key))) continue;
      await this.ensureUpdated(mode);
    }
  }

  next(now: Date): Promise<GameModeOutboxEntry | undefined> {
    return this.store.next(now);
  }

  sent(id: string, at: Date): Promise<void> {
    return this.store.sent(id, at);
  }

  retry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    return this.store.retry(id, error, nextAttemptAt);
  }

  private async insert(dedupeKey: string, event: GameModeEvent): Promise<void> {
    await this.store.enqueue(dedupeKey, event.key, event.payload);
  }
}
