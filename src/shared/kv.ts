// UN ALMACÉN DE CLAVE-VALOR CON PLAZO, que es lo único que el registro de partidas vivas
// necesita: anotar algo que caduca solo y preguntarlo después. Vive en `shared/` porque es
// genuinamente portable —no sabe de dominó, ni de salas, ni de asientos— y porque lo que hay
// del otro lado es infraestructura del proceso, no de una feature.
//
// **No tiene un adaptador de Redis, y eso es a propósito.** La forma está COPIADA de la
// interfaz `Presence` de Colyseus (`@colyseus/core/build/presence/Presence.d.ts`), así que la
// `RedisPresence` la satisface POR ESTRUCTURA: el composition root le pasa el mismo `presence`
// que ya le pasa al servidor, y no hay una clase en el medio traduciendo. Es lo que permite que
// el adaptador de Redis del dominó sea CERO líneas propias.
//
// LOS SIETE MÉTODOS SON LOS SIETE QUE SE USAN, y la lista corta es una decisión. Los tres del
// hash sostienen el censo de salas: cada sala renueva su propio campo, algo que el plazo de una
// clave entera no puede expresar sin llevarse también las salas vivas de otros procesos. No se
// agregan conjuntos ni sorted sets: dominó no tiene la pregunta que los necesitaría.
//
// El tipo de retorno de `setex` es laxo (`unknown`) porque nadie lee el resultado: es lo que
// permite que una implementación que devuelve `any` —como la de Colyseus— encaje sin castear.
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  // Sin plazo: configuración operativa que debe sobrevivir mientras viva el almacén.
  set(key: string, value: string): Promise<unknown>;
  // Guardar con plazo, en SEGUNDOS. La unidad no es un capricho: es la de Redis, y es la que la
  // implementación real recibe tal cual.
  setex(key: string, value: string, seconds: number): Promise<unknown>;
  // NO promete, igual que en `Presence`. Es la misma asimetría que el historial ya tiene entre
  // `record` y `of`: borrar pasa por el camino de una sala que se está muriendo, y ahí no hay a
  // quién devolverle el error.
  del(key: string): void;
  sadd(key: string, value: string): Promise<unknown>;
  srem(key: string, value: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<unknown>;
}

interface Entry {
  readonly value: string | Map<string, string> | Set<string>;
  expiresAt: number;
}

// LA IMPLEMENTACIÓN DE MEMORIA, que NO es un doble: es la del proceso único —el caso del
// dominó hasta que alguien configure Redis— y la que usa la suite entera. Es el mismo criterio
// que `MemoryHistory` (ver `src/di-container.ts`): la implementación de una instancia que elige
// no compartir, no un stub de test.
//
// Caduca POR RELOJ INYECTADO y no por temporizadores: un test no debería tener que esperar dos
// minutos para ver vencer una clave de dos minutos. De paso, un `setTimeout` por clave mantendría
// vivo el event loop del CLI de replay, que es el bug que `mongo.close()` ya tuvo que resolver.
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | undefined> {
    const value = this.live(key)?.value;
    return typeof value === "string" ? value : undefined;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.entries.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
    return undefined;
  }

  async setex(key: string, value: string, seconds: number): Promise<unknown> {
    // Se pisa la entrada ENTERA, plazo incluido, que es lo que hace que el latido sirva: si
    // conservara el vencimiento anterior, una sala viva perdería sus claves igual.
    this.entries.set(key, { value, expiresAt: this.now() + seconds * 1000 });
    return undefined;
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  async sadd(key: string, value: string): Promise<unknown> {
    const current = this.live(key)?.value;
    const set = current instanceof Set ? current : new Set<string>();
    set.add(value);
    this.entries.set(key, {
      value: set,
      expiresAt: this.live(key)?.expiresAt ?? Number.POSITIVE_INFINITY,
    });
    return undefined;
  }

  async srem(key: string, value: string): Promise<unknown> {
    const current = this.live(key)?.value;
    if (!(current instanceof Set)) return undefined;
    current.delete(value);
    if (current.size === 0) this.entries.delete(key);
    return undefined;
  }

  async smembers(key: string): Promise<string[]> {
    const current = this.live(key)?.value;
    return current instanceof Set ? [...current] : [];
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    const entry = this.live(key);
    if (entry) entry.expiresAt = this.now() + seconds * 1000;
    return undefined;
  }

  async hset(key: string, field: string, value: string): Promise<unknown> {
    const current = this.live(key)?.value;
    const hash = current instanceof Map ? current : new Map<string, string>();
    hash.set(field, value);
    this.entries.set(key, { value: hash, expiresAt: Number.POSITIVE_INFINITY });
    return undefined;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const value = this.live(key)?.value;
    return value instanceof Map ? Object.fromEntries(value) : {};
  }

  async hdel(key: string, field: string): Promise<unknown> {
    const value = this.live(key)?.value;
    if (!(value instanceof Map)) return undefined;
    value.delete(field);
    if (value.size === 0) this.entries.delete(key);
    return undefined;
  }

  // Vencida es INEXISTENTE, y se borra al leerla: sin esto el Map crecería con las claves de
  // cada sala que pasó por este proceso, que es una fuga con forma de caché.
  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
