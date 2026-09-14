import { type Collection, type Db, type Document, MongoClient } from "mongodb";

// LA CONEXIÓN a Mongo, y nada más. Vive en `shared/` y no dentro de `features/match/` por la
// regla de imports 2 (`core-no-runtime`): `mongodb` es un paquete de runtime, el core no puede
// nombrarlo, y `shared/` es lo único importable desde todos lados. Lo que NO sube acá es el
// NOMBRE ni la FORMA de la colección: eso es lo único que la feature sabe y esta clase no.
//
// Con el driver oficial y no con mongoose, igual que truco: una capa de modelos que pluraliza
// nombres de colección a partir del nombre del modelo adivina justo lo que acá se quiere dicho.
// Acá el nombre se pasa por constructor y se lee en el composition root.
//
// PORTADA DE `truco-backend-v2` (`src/shared/mongo.ts`) SIN DOS MÉTODOS, y las dos ausencias
// son decisiones:
//   - `announce()`, que cuenta los documentos de cada colección al arrancar. Allá es la
//     contramedida a que los nombres de colección sean CONFIGURABLES —se escribe en colecciones
//     de v1, cuyos nombres son implícitos, y un nombre mal puesto sería un catálogo vacío que
//     se descubre cuando un jugador no puede jugar—. Acá el nombre es una constante del código
//     (`HISTORY_COLLECTION`), así que no hay nada que verificar al arrancar: no existe el
//     entorno que pueda equivocarlo.
//   - `ping()`, cuyo único consumidor allá es el chequeo de LISTO. El dominó no expone
//     `/health` ni `/ready`, así que sería un método sin llamador.
export class Mongo {
  private client?: MongoClient;
  private db?: Db;
  private connecting?: Promise<Db>;

  constructor(private readonly uri: string) {}

  // PEREZOSA: el proceso arranca aunque la base tarde o esté caída, y quien primero necesite
  // un documento paga la espera. Es la misma decisión que `HistoryPort.record` devolviendo
  // `void` —la base no puede frenar una partida— aplicada al arranque: un servidor que no
  // levanta porque Mongo no contesta es una mesa que nadie puede jugar por un registro de
  // soporte que nadie está mirando.
  //
  // `connecting` memoiza el intento EN VUELO, no el resultado: sin él, veinte salas que
  // arrancan a la vez abren veinte conexiones. El `finally` lo limpia también cuando falla, y
  // eso es lo que hace que un Mongo caído se pueda reintentar en la próxima escritura en vez
  // de dejar el proceso pegado a una promesa rechazada para siempre.
  async ready(): Promise<Db> {
    if (this.db) return this.db;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async collection<T extends Document>(name: string): Promise<Collection<T>> {
    return (await this.ready()).collection<T>(name);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.db = undefined;
    this.connecting = undefined;
    await client?.close().catch(() => {});
  }

  private async open(): Promise<Db> {
    const client = new MongoClient(this.uri);
    await client.connect();
    this.client = client;
    // LA BASE SALE DE LA URI (`mongodb://host:puerto/nombre`), como en truco y como en v1. Que
    // el nombre viaje ahí y no en una variable aparte es lo que hace que apuntar a otra base
    // sea cambiar UN valor, y no dos que hay que acordarse de mover juntos.
    this.db = client.db();
    return this.db;
  }
}
