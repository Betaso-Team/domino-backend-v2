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
// LOS TRES MÉTODOS SON LOS TRES QUE SE USAN, y la lista corta es una decisión. Truco pide
// además `sadd`/`srem`/`smembers`/`expire` porque su registro tiene que contestar a qué torneos
// les quedan partidas; el dominó no tiene torneos ni matchmaking, así que un conjunto acá sería
// una capacidad sin un solo llamador — y un puerto con métodos que nadie implementa contra algo
// real es un puerto que nadie puede verificar. Si el día de mañana entra esa pregunta, se
// agregan: `Presence` ya las tiene, así que ampliar el puerto no rompe al adaptador.
//
// El tipo de retorno de `setex` es laxo (`unknown`) porque nadie lee el resultado: es lo que
// permite que una implementación que devuelve `any` —como la de Colyseus— encaje sin castear.
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  // Guardar con plazo, en SEGUNDOS. La unidad no es un capricho: es la de Redis, y es la que la
  // implementación real recibe tal cual.
  setex(key: string, value: string, seconds: number): Promise<unknown>;
  // NO promete, igual que en `Presence`. Es la misma asimetría que el historial ya tiene entre
  // `record` y `of`: borrar pasa por el camino de una sala que se está muriendo, y ahí no hay a
  // quién devolverle el error.
  del(key: string): void;
}

interface Entry {
  readonly value: string;
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
    return this.live(key)?.value;
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
