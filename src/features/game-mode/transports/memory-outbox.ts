import type { GameMode } from "../core/game-mode.js";
import { type GameModeEvent, createdEventOf, updatedEventOf } from "../events.js";
import {
  type Clock,
  type GameModeOutbox,
  type GameModeOutboxEntry,
  createdKeyOf,
  revisionKeysOf,
  syncKeyOf,
  updatedKeyOf,
} from "../outbox.js";

// EL OUTBOX DE LA INSTANCIA QUE NO TIENE MONGO, y NO un doble de test: es la misma decisión que
// `MemoryHistory` y `MemoryGameModeRepository`. La presencia de `MONGO_URI` elige, y sin ella el
// proceso levanta igual, el catálogo vive en memoria y sus eventos también. Por eso no se llama
// "fake" — un fake sólo existe en la suite, y esto se despliega.
//
// LO QUE SE PIERDE ES LA DURABILIDAD Y NADA MÁS: las claves de deduplicación, el orden de entrega, el
// no-adelantarse y la reconciliación son los MISMOS que los del adaptador Mongo, y lo mide el contrato
// compartido (`tests/outbox-contract.ts`) corriendo contra los dos. Si acá el orden fuera otro, la
// suite estaría certificando un comportamiento que la producción no tiene.

// La entrada guardada, con lo único que cambia después de nacer. Es un `GameModeOutboxEntry` sin los
// `readonly`: el puerto promete inmutabilidad hacia afuera y el almacén tiene que poder escribir.
type StoredEntry = { -readonly [K in keyof GameModeOutboxEntry]: GameModeOutboxEntry[K] };

export class MemoryGameModeOutbox implements GameModeOutbox {
  // EN ORDEN DE INSERCIÓN, que es lo que el adaptador Mongo obtiene ordenando por `_id`. El orden es
  // la garantía: entregar fuera de orden deja al consumidor con el modo viejo.
  private readonly entries: StoredEntry[] = [];
  // El índice de deduplicación, que del otro lado es el índice único de la base. Sin él, cada tick de
  // reconciliación sería un evento más.
  private readonly keys = new Set<string>();
  private sequence = 0;

  constructor(private readonly clock: Clock) {}

  async enqueueCreated(mode: GameMode): Promise<void> {
    this.insert(createdKeyOf(mode), createdEventOf(mode));
  }

  async ensureUpdated(mode: GameMode): Promise<void> {
    this.insert(updatedKeyOf(mode), updatedEventOf(mode));
  }

  async sync(modes: readonly GameMode[], batchId: string): Promise<number> {
    for (const mode of modes) {
      this.insert(syncKeyOf(batchId, mode), updatedEventOf(mode));
    }
    // LO QUE SE ENCOLÓ, que es lo que el `POST /sync` de v1 contesta como `synced`. No se cuentan los
    // insertados: repetir el mismo lote no duplica, y devolver menos haría que el operador creyera
    // que se perdieron modos.
    return modes.length;
  }

  async reconcile(modes: readonly GameMode[]): Promise<void> {
    for (const mode of modes) {
      if (revisionKeysOf(mode).some((key) => this.keys.has(key))) continue;
      await this.ensureUpdated(mode);
    }
  }

  async next(now: Date): Promise<GameModeOutboxEntry | undefined> {
    const oldest = this.entries.find((entry) => entry.status === "PENDING");
    // SI EL MÁS VIEJO TODAVÍA NO VENCIÓ, NO SE OFRECE EL SIGUIENTE. Es la regla de no adelantarse, y
    // se expresa acá y no en el llamador: un dispatcher que buscara "el primero que ya venció"
    // publicaría el segundo `updated` antes que el primero.
    if (!oldest || oldest.nextAttemptAt.getTime() > now.getTime()) return undefined;
    return { ...oldest };
  }

  async sent(id: string, at: Date): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry) return;
    entry.status = "SENT";
    entry.sentAt = at;
  }

  async retry(id: string, error: string, nextAttemptAt: Date): Promise<void> {
    const entry = this.entries.find((one) => one.id === id);
    if (!entry) return;
    // SE ACUMULA, no se reescribe: el backoff del dispatcher se calcula con este número.
    entry.attempts += 1;
    entry.lastError = error;
    entry.nextAttemptAt = nextAttemptAt;
  }

  private insert(dedupeKey: string, event: GameModeEvent): void {
    if (this.keys.has(dedupeKey)) return;
    const now = new Date(this.clock.now());
    this.sequence += 1;
    this.keys.add(dedupeKey);
    this.entries.push({
      // Un contador y no un identificador con forma: nadie lo interpreta, sólo vuelve en `sent` y
      // `retry`. El orden lo da el arreglo, igual que del otro lado lo da el `_id`.
      id: String(this.sequence),
      dedupeKey,
      routingKey: event.key,
      payload: event.payload,
      status: "PENDING",
      attempts: 0,
      createdAt: now,
      // NACE VENCIDA: el primer intento es AHORA. Nacer con el plazo del primer backoff le agregaría
      // un segundo de latencia a cada cambio del panel.
      nextAttemptAt: now,
    });
  }
}
