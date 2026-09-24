import type { Logger } from "@/logger";
import type { Collection } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../history";
import {
  HISTORY_COLLECTION,
  type HistoryStore,
  type MatchHistoryDocument,
  MongoHistory,
} from "./mongo-history";

// CONTRA UN DOBLE DEL DRIVER, y no contra un Mongo de verdad. La suite del dominó no
// depende de NINGÚN servicio externo y ésa es una propiedad que se decidió no perder: un
// test de contra-base que solo corre en la máquina que tiene Mongo levantado es un test que
// nadie ve fallar, y peor —si el entorno del que corre `npm test` tuviera `MONGO_URI`, el
// composition root cablearía Mongo y los cuarenta archivos de la suite pasarían a leer el
// historial de una base—. Por eso `vitest.setup.ts` BORRA `MONGO_URI` en vez de ignorarla.
//
// Lo que este doble NO puede probar es que Mongo acepte el documento; eso lo cubre `tsc`,
// que es el gate de este repo: el update va tipado como `UpdateFilter<MatchHistoryDocument>`
// del propio driver, así que un `$push` sobre un campo que no es arreglo, un operador mal
// escrito o una entrada de otra forma no compilan. Lo que sí prueba, y es lo que se rompe en
// silencio, son las DECISIONES: que sea `$push` y no `$set` (o cada lote pisa al anterior),
// que el filtro sea por partida (o dos mesas comparten documento) y que un fallo de la base
// no se propague al camino del comando.
const entry = (seq: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  matchId: "m-1",
  seq,
  at: 1_700_000_000_000 + seq,
  roundNumber: 1,
  source: "PLAYER",
  kind: "COMMAND",
  type: "PLAY_TILE",
  payload: {},
  ...over,
});

function fakeLogger(): Logger {
  const self: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => self,
  };
  return self;
}

// El doble de la CONEXIÓN implementa `HistoryStore`, que es la interfaz que el adaptador
// declara y que `Mongo` satisface estructuralmente: si la conexión real cambiara de firma,
// el que deja de compilar es `Mongo`, no este archivo en silencio. El único cast es el de la
// colección, y es inevitable —`Collection<T>` del driver son decenas de métodos— pero no
// afloja lo que importa: los ARGUMENTOS de `updateOne` se siguen chequeando contra el tipo
// real del driver.
function storeWith(document: MatchHistoryDocument | null = null) {
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const findOne = vi.fn().mockResolvedValue(document);
  const collection = vi.fn(
    async (_name: string) => ({ updateOne, findOne }) as unknown as Collection<never>,
  );
  return { store: { collection } as unknown as HistoryStore, updateOne, findOne, collection };
}

// Le da al `void this.append(...)` de dentro de `record` la vuelta de microtasks que
// necesita para llegar al doble. `record` devuelve `void` por contrato, así que no hay nada
// que esperar desde afuera: esto es el test adaptándose a la decisión, no al revés.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MongoHistory: escritura", () => {
  it("un documento por partida, con la cabecera escrita una sola vez", async () => {
    const { store, updateOne } = storeWith();
    new MongoHistory(store, fakeLogger()).record([entry(1)]);
    await settle();

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0] ?? [];
    expect(filter).toEqual({ matchId: "m-1" });
    expect(options).toEqual({ upsert: true });
    // `$setOnInsert` y no `$set`: la cabecera describe el nacimiento del documento, así que
    // el segundo lote no puede reescribirla. Con `$set`, `createdAt` avanzaría con cada
    // jugada y dejaría de ser el instante en que la partida empezó a grabarse.
    expect(update.$setOnInsert).toMatchObject({ matchId: "m-1" });
    expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date);
  });

  // ES EL TEST QUE JUSTIFICA EL DISEÑO: un documento por partida con las entradas en un
  // arreglo solo sirve si los lotes se ACUMULAN. El `seq` es el orden y perder un lote es
  // perder la mitad de una jugada.
  it("los lotes se acumulan con $push/$each, no se pisan", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([
      entry(1),
      entry(2, { source: "SYSTEM", kind: "EVENT", type: "MATCH_RESOLVED" }),
    ]);
    history.record([entry(3)]);
    await settle();

    expect(updateOne).toHaveBeenCalledTimes(2);
    const first = updateOne.mock.calls[0]?.[1];
    const second = updateOne.mock.calls[1]?.[1];
    expect(first.$push.entries.$each.map((e: HistoryEntry) => e.seq)).toEqual([1, 2]);
    expect(first.$push.entries.$each[1].source).toBe("SYSTEM");
    expect(second.$push.entries.$each.map((e: HistoryEntry) => e.seq)).toEqual([3]);
    // Nadie escribe `entries` fuera del `$push`: un `$set` sobre el mismo campo lo dejaría
    // en el último lote y el historial sería siempre la última jugada.
    expect(first.$set.entries).toBeUndefined();
    expect(first.$setOnInsert.entries).toBeUndefined();
  });

  it("cada partida escribe contra su propio filtro", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    history.record([entry(1, { matchId: "m-2" })]);
    await settle();

    expect(updateOne.mock.calls.map((call) => call[0])).toEqual([
      { matchId: "m-1" },
      { matchId: "m-2" },
    ]);
  });

  it("un lote vacío no toca la base", async () => {
    const { store, updateOne, collection } = storeWith();
    new MongoHistory(store, fakeLogger()).record([]);
    await settle();

    expect(updateOne).not.toHaveBeenCalled();
    // Ni siquiera se pide la colección: pedirla dispara la conexión perezosa, así que un
    // lote vacío abriría una conexión para no escribir nada.
    expect(collection).not.toHaveBeenCalled();
  });

  // QUE LA BASE FALLE NO PUEDE FRENAR UNA PARTIDA. Es el contrato de `HistoryPort.record`
  // —`void`, no promesa, porque lo llaman el camino de un comando y el de un timer— y acá
  // es donde de verdad se cobra: el adaptador anterior no podía fallar.
  it("un fallo de la base no se propaga: se loguea y la partida sigue", async () => {
    const { store, updateOne } = storeWith();
    updateOne.mockRejectedValue(new Error("sin conexión"));
    const logger = fakeLogger();

    expect(() => new MongoHistory(store, logger).record([entry(1)])).not.toThrow();
    await settle();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("historial"),
      expect.objectContaining({ matchId: "m-1" }),
    );
  });
});

describe("MongoHistory: lectura", () => {
  it("devuelve las entradas grabadas de esa partida", async () => {
    const entries = [entry(1), entry(2)];
    const { store, findOne } = storeWith({
      matchId: "m-1",
      entries,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await new MongoHistory(store, fakeLogger()).of("m-1")).toEqual(entries);
    expect(findOne).toHaveBeenCalledWith({ matchId: "m-1" });
  });

  // VACÍO Y NO UN FALLO: es lo que ya distinguen sus dos llamadores. El endpoint interno
  // responde 404 con el arreglo vacío y el CLI de replay corta con "no hay historial para
  // esa partida", así que una partida inexistente no es un error de la lectura.
  it("una partida sin documento devuelve vacío", async () => {
    const { store } = storeWith(null);

    expect(await new MongoHistory(store, fakeLogger()).of("m-inexistente")).toEqual([]);
  });

  // El nombre de la colección NO es configurable —el dominó es su único escritor— y por eso
  // es una constante exportada y no una variable de entorno. El test la ata al valor que
  // `replay.ts` ya nombraba en prosa antes de que existiera la persistencia.
  it("escribe y lee de la misma colección, que es la que el replay ya nombraba", async () => {
    const { store, collection } = storeWith();
    await new MongoHistory(store, fakeLogger()).of("m-1");

    expect(HISTORY_COLLECTION).toBe("match_history");
    expect(collection).toHaveBeenCalledWith(HISTORY_COLLECTION);
  });
});

// LO QUE SE PIERDE SI EL APAGADO NO ESPERA. `record` devuelve `void` por contrato —lo llaman
// el camino de un comando y el de un timer, y ninguno espera— y NO reintenta: un lote que
// todavía está viajando cuando alguien cierra la conexión no se vuelve a intentar nunca. Y el
// último lote de una partida es justamente el que lleva su desenlace.
//
// `drain()` es la contrapartida del `void`: el único llamador es el apagado ordenado, que lo
// espera ANTES de cerrar Mongo.
describe("MongoHistory: el drenado del apagado", () => {
  it("espera a los lotes que todavía están viajando", async () => {
    let liberar: (() => void) | undefined;
    const { store, updateOne } = storeWith();
    updateOne.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          liberar = () => resolve();
        }),
    );
    const history = new MongoHistory(store, fakeLogger());
    history.record([entry(1)]);
    await settle();

    let drenado = false;
    const drain = history.drain().then(() => {
      drenado = true;
    });

    // Todavía no: el lote sigue en vuelo. Si `drain()` resolviera acá, cerrar Mongo a
    // continuación mataría la escritura a mitad de camino.
    await settle();
    expect(drenado).toBe(false);

    liberar?.();
    await drain;
    expect(drenado).toBe(true);
  });

  // Un lote que FALLA tampoco puede dejar el apagado colgado: ya se logueó (es lo único que
  // se le debe al operador) y lo que queda es cerrar. Un `drain()` que se propaga con el
  // rechazo cortaría el resto del apagado, que es peor que perder el lote.
  it("un lote que falla lo deja drenado igual, no colgado ni roto", async () => {
    const { store, updateOne } = storeWith();
    updateOne.mockRejectedValue(new Error("mongo caído"));
    const history = new MongoHistory(store, fakeLogger());
    history.record([entry(1)]);

    await expect(history.drain()).resolves.toBeUndefined();
  });

  // Sin nada en vuelo resuelve de una: el apagado de una instancia que no grabó nada no paga
  // ni un tick.
  it("sin lotes en vuelo resuelve de inmediato", async () => {
    const { store } = storeWith();

    await expect(new MongoHistory(store, fakeLogger()).drain()).resolves.toBeUndefined();
  });
});
