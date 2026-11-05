import type { Logger } from "@/logger";
import { type Collection, MongoOperationTimeoutError, MongoServerError } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { type HistoryEntry, MatchListTimeoutError } from "../history";
import {
  HISTORY_COLLECTION,
  HISTORY_WRITE_TIMEOUT_MS,
  type HistoryStore,
  LIST_MAX_TIME_MS,
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
  const createIndexes = vi.fn().mockResolvedValue([]);
  const collection = vi.fn(
    async (_name: string) =>
      ({ updateOne, findOne, createIndexes }) as unknown as Collection<never>,
  );
  return {
    store: { collection } as unknown as HistoryStore,
    updateOne,
    findOne,
    createIndexes,
    collection,
  };
}

// LAS ESCRITURAS DE LA TIMELINE, sin las marcas de pérdida: un lote fallido encola detrás la marca
// `timelineIncomplete` de su partida, que también es un `updateOne`.
const pushesOf = (updateOne: { mock: { calls: unknown[][] } }) =>
  updateOne.mock.calls.filter(
    (call) => (call[1] as { $push?: { timeline?: unknown } } | undefined)?.$push?.timeline,
  );

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
    expect(options).toEqual({ upsert: true, timeoutMS: HISTORY_WRITE_TIMEOUT_MS });
    // `$setOnInsert` y no `$set`: la cabecera describe el nacimiento del documento, así que
    // el segundo lote no puede reescribirla. Con `$set`, `createdAt` avanzaría con cada
    // jugada y dejaría de ser el instante en que la partida empezó a grabarse.
    expect(update.$setOnInsert).toMatchObject({ matchId: "m-1" });
    expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date);
  });

  // ES EL TEST QUE JUSTIFICA EL DISEÑO: un documento por partida con las entradas en un
  // arreglo solo sirve si los lotes se ACUMULAN. El `seq` es el orden y perder un lote es
  // perder la mitad de una jugada.
  it("los lotes se acumulan en la timeline con $push/$each, no se pisan", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([
      entry(1),
      entry(2, { source: "SYSTEM", kind: "EVENT", type: "MATCH_RESOLVED" }),
    ]);
    // Con la escritura anterior ya hecha: dos lotes del MISMO tick viajan juntos (ver «un `$push`
    // por trabajo»), así que para ver dos `updateOne` el segundo llega después.
    await settle();
    history.record([entry(3)]);
    await settle();

    expect(updateOne).toHaveBeenCalledTimes(2);
    const first = updateOne.mock.calls[0]?.[1];
    const second = updateOne.mock.calls[1]?.[1];
    expect(first.$push.timeline.$each.map((e: HistoryEntry) => e.seq)).toEqual([1, 2]);
    expect(first.$push.timeline.$each[1].source).toBe("SYSTEM");
    expect(second.$push.timeline.$each.map((e: HistoryEntry) => e.seq)).toEqual([3]);
    // EL INSTANTE COMO FECHA (truco `7498991`): se lee como fecha en cualquier cliente.
    expect(first.$push.timeline.$each[0].at).toEqual(new Date(1_700_000_000_001));
    // Nadie escribe la timeline fuera del `$push`: un `$set` sobre el mismo campo la dejaría
    // en el último lote y el historial sería siempre la última jugada.
    expect(first.$set.timeline).toBeUndefined();
    expect(first.$setOnInsert.timeline).toBeUndefined();
    expect(first.$setOnInsert.version).toBe(2.1);
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

// UN `$push` POR TRABAJO DE LA COLA. El comando y sus eventos son dos lotes del mismo tick, y con
// la escritura anterior todavía en vuelo se apilan más: cada uno era un `updateOne`. El lote se
// suma al pendiente de la partida hasta que su trabajo arranca y lo sella.
describe("MongoHistory: un $push por lote pendiente", () => {
  const seqsOf = (call: unknown[] | undefined) =>
    (call?.[1] as { $push: { timeline: { $each: HistoryEntry[] } } }).$push.timeline.$each.map(
      (e) => e.seq,
    );
  const ROUND = { roundNumber: 1, endReason: "DOMINO" as const, starterId: "seat-1", hands: [] };

  it("el comando y sus eventos del mismo tick viajan en un solo updateOne, en orden", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    history.record([entry(2, { source: "SYSTEM", kind: "EVENT", type: "MATCH_RESOLVED" })]);
    await settle();

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(seqsOf(updateOne.mock.calls[0])).toEqual([1, 2]);
  });

  it("con la escritura anterior colgada, los lotes que llegan se juntan en el siguiente", async () => {
    let liberar: (() => void) | undefined;
    const { store, updateOne } = storeWith();
    updateOne.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          liberar = () => resolve();
        }),
    );
    const history = new MongoHistory(store, fakeLogger());
    history.record([entry(1)]);
    await settle();
    expect(updateOne).toHaveBeenCalledTimes(1);

    history.record([entry(2)]);
    history.record([entry(3)]);
    history.record([entry(4)]);
    await settle();
    // Todavía no: la cola es por partida y la primera no volvió.
    expect(updateOne).toHaveBeenCalledTimes(1);

    liberar?.();
    await history.drain();
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(seqsOf(updateOne.mock.calls[0])).toEqual([1]);
    expect(seqsOf(updateOne.mock.calls[1])).toEqual([2, 3, 4]);
  });

  // EL DESENLACE LLEGA DETRÁS DE LA ENTRADA QUE LO CUENTA, y lo que se graba después del cierre no
  // se cuela delante: la mano y el cierre sellan el pendiente antes de encolarse.
  it("la mano y el cierre sellan: lo de antes va antes y lo de después, después", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    history.round("m-1", ROUND);
    history.record([entry(2)]);
    history.record([entry(3)]);
    await history.drain();

    const calls = updateOne.mock.calls;
    expect(calls).toHaveLength(3);
    expect(seqsOf(calls[0])).toEqual([1]);
    expect(calls[1]?.[1].$push.rounds).toEqual(ROUND);
    expect(seqsOf(calls[2])).toEqual([2, 3]);
  });

  it("la marca de estadísticas también sella", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    const marca = history.settled("m-1");
    history.record([entry(2)]);
    await marca;
    await history.drain();

    const calls = updateOne.mock.calls;
    expect(calls).toHaveLength(3);
    expect(seqsOf(calls[0])).toEqual([1]);
    expect(calls[1]?.[1]).toEqual({ $unset: { statsPending: "" } });
    expect(seqsOf(calls[2])).toEqual([2]);
  });

  it("cada partida junta solo lo suyo", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    history.record([entry(1, { matchId: "m-2" })]);
    history.record([entry(2)]);
    await history.drain();

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0]?.[0]).toEqual({ matchId: "m-1" });
    expect(seqsOf(updateOne.mock.calls[0])).toEqual([1, 2]);
    expect(seqsOf(updateOne.mock.calls[1])).toEqual([1]);
  });

  it("el drenado espera también a lo pendiente que todavía no salió", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    history.record([entry(2)]);
    await history.drain();

    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(seqsOf(updateOne.mock.calls[0])).toEqual([1, 2]);
  });

  // UN LOTE FALLIDO SE PIERDE Y SE LOGUEA, como antes; el pendiente quedó sellado igual, así que lo
  // que llega después viaja en su propio `updateOne` y no queda pegado a un trabajo muerto.
  it("un fallo no envenena: el lote siguiente viaja en su propia escritura", async () => {
    const { store, updateOne } = storeWith();
    updateOne.mockRejectedValueOnce(new Error("sin conexión"));
    const logger = fakeLogger();
    const history = new MongoHistory(store, logger);

    history.record([entry(1)]);
    history.record([entry(2)]);
    await history.drain();
    history.record([entry(3)]);
    await history.drain();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("lote"),
      expect.objectContaining({ matchId: "m-1", entries: 2 }),
    );
    const pushes = pushesOf(updateOne);
    expect(pushes).toHaveLength(2);
    expect(seqsOf(pushes[1])).toEqual([3]);
  });

  // Y SI FALLA ANTES DE ESCRIBIR —la colección no se pudo preparar—, el pendiente también queda
  // sellado: si no, todo lo que llegara después se sumaría a un arreglo que nadie va a mandar.
  it("un fallo al pedir la colección deja el pendiente sellado", async () => {
    const { store, updateOne, collection } = storeWith();
    collection.mockRejectedValueOnce(new Error("mongo caído"));
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    await history.drain();
    history.record([entry(2)]);
    await history.drain();

    const pushes = pushesOf(updateOne);
    expect(pushes).toHaveLength(1);
    expect(seqsOf(pushes[0])).toEqual([2]);
  });
});

// La cabecera y el cierre de una partida de prueba, para los tests que abren y cierran.
const SETUP = {
  roomId: "room-1",
  table: { gameModeId: "g", name: "$peligro", entryFeeInUC: 1, prizeInUC: 2, isFree: false },
  matchConfig: {
    playersQuantity: 2,
    pointsToWin: 100,
    startingScore: { teamA: 0, teamB: 0 },
    timeoutsInMs: {},
    seed: "s",
    teamAssignment: "SHUFFLED" as const,
    isDealWindowEnabled: true,
    tilesPerPlayer: 7,
    betLevels: [],
    enableBots: false,
    isRematchEnabled: true,
  },
  seats: [],
};
const CLOSING = {
  ...SETUP,
  status: "finished" as const,
  matchEndedAt: 2_000,
  matchEndReason: "SCORE" as const,
  winnerIds: [],
  players: [],
  rateId: "r",
  betMultiplier: { offeredValues: [], finalValue: 1, proposals: [] },
  rankingMultiplier: { base: 1, extra: 0, final: 1 },
};

// UN MONGO LENTO NO PUEDE ACUMULAR SIN TECHO. Cada escritura del historial lleva su plazo propio
// (el `MongoClient` es compartido y no se toca): vencido, falla como cualquier otro fallo —se
// loguea y la partida sigue— y la cola de la partida pasa a la siguiente.
describe("MongoHistory: plazos y topes", () => {
  const ROUND = { roundNumber: 1, endReason: "DOMINO" as const, starterId: "seat-1", hands: [] };

  it("cada escritura del historial lleva su propio plazo", async () => {
    const { store, updateOne } = storeWith();
    const history = new MongoHistory(store, fakeLogger());

    history.open("m-1", { ...SETUP, matchStartedAt: 1_000 });
    history.record([entry(1)]);
    history.round("m-1", ROUND);
    history.close("m-1", CLOSING);
    await history.settled("m-1");
    await history.drain();

    expect(HISTORY_WRITE_TIMEOUT_MS).toBe(30_000);
    expect(updateOne).toHaveBeenCalledTimes(5);
    for (const call of updateOne.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMS: 30_000 });
    }
  });

  it("una escritura que vence no frena la siguiente de la misma partida", async () => {
    const { store, updateOne } = storeWith();
    updateOne.mockRejectedValueOnce(new MongoOperationTimeoutError("vencido"));
    const logger = fakeLogger();
    const history = new MongoHistory(store, logger);

    history.record([entry(1)]);
    await history.drain();
    history.record([entry(2)]);
    await history.drain();

    const pushes = pushesOf(updateOne);
    expect(pushes).toHaveLength(2);
    expect(
      (
        pushes[1]?.[1] as { $push: { timeline: { $each: HistoryEntry[] } } }
      ).$push.timeline.$each.map((e) => e.seq),
    ).toEqual([2]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  // Una promesa que el test resuelve a mano: el Mongo lento pero vivo.
  const colgado = () => {
    let liberar: () => void = () => {};
    const promesa = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    return { promesa, liberar: () => liberar() };
  };
  const marcasDe = (updateOne: ReturnType<typeof storeWith>["updateOne"], matchId: string) =>
    updateOne.mock.calls
      .filter((call) => call[0]?.matchId === matchId && call[1]?.$set?.timelineIncomplete)
      .map((call) => call[1].$inc.lostEntries);

  it("lo que no entra en el pendiente de la partida se descarta, se cuenta y se marca", async () => {
    const { store, updateOne } = storeWith();
    const lento = colgado();
    updateOne.mockImplementationOnce(() => lento.promesa);
    const history = new MongoHistory(store, fakeLogger(), { maxPendingPerMatch: 3 });

    history.record([entry(1)]);
    await settle();
    for (let seq = 2; seq <= 7; seq++) history.record([entry(seq)]);
    lento.liberar();
    await history.drain();

    const pushes = updateOne.mock.calls.filter((call) => call[1]?.$push?.timeline);
    expect(
      pushes.map((call) => call[1].$push.timeline.$each.map((e: HistoryEntry) => e.seq)),
    ).toEqual([[1], [2, 3, 4]]);
    expect(marcasDe(updateOne, "m-1")).toEqual([3]);
  });

  it("el tope del proceso se reparte entre las partidas, y cada una cuenta lo suyo", async () => {
    const { store, updateOne } = storeWith();
    const lento = colgado();
    updateOne.mockImplementation(() => lento.promesa);
    const history = new MongoHistory(store, fakeLogger(), { maxPendingTotal: 10 });

    history.record([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => entry(seq)));
    history.record([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => entry(seq, { matchId: "m-2" })));
    await settle();
    lento.liberar();
    await history.drain();

    const pushDe = (matchId: string) =>
      updateOne.mock.calls.find(
        (call) => call[0]?.matchId === matchId && call[1]?.$push?.timeline,
      )?.[1].$push.timeline.$each.length;
    expect(pushDe("m-1")).toBe(8);
    expect(pushDe("m-2")).toBe(2);
    expect(marcasDe(updateOne, "m-1")).toEqual([]);
    expect(marcasDe(updateOne, "m-2")).toEqual([6]);
  });

  it("un lote que falla marca su partida una vez, con lo que perdió, detrás del lote", async () => {
    const { store, updateOne } = storeWith();
    updateOne.mockRejectedValueOnce(new MongoOperationTimeoutError("vencido"));
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1), entry(2), entry(3)]);
    await history.drain();

    expect(updateOne).toHaveBeenCalledTimes(2);
    const [filter, marca, options] = updateOne.mock.calls[1] ?? [];
    expect(filter).toEqual({ matchId: "m-1" });
    expect(marca.$set.timelineIncomplete).toBe(true);
    expect(marca.$inc).toEqual({ lostEntries: 3 });
    // La marca no toca el desenlace: `$set` de dos campos, nunca el `$replaceWith` del cierre.
    expect(Object.keys(marca.$set).sort()).toEqual(["timelineIncomplete", "updatedAt"]);
    expect(options).toEqual({ upsert: true, timeoutMS: HISTORY_WRITE_TIMEOUT_MS });
  });

  it("una marca que falla no encola otra: lo perdido espera a la próxima pérdida", async () => {
    const { store, updateOne } = storeWith();
    updateOne.mockRejectedValue(new Error("mongo caído"));
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1), entry(2)]);
    await history.drain();
    // El lote y su marca: nada más, aunque la marca también falló.
    expect(updateOne).toHaveBeenCalledTimes(2);

    updateOne.mockResolvedValue({ acknowledged: true });
    history.record([entry(3)]);
    history.record([]);
    await history.drain();
    // La siguiente pérdida no hubo: lo que quedó sin marcar sigue esperando, sin bucle.
    expect(marcasDe(updateOne, "m-1")).toEqual([2]);
  });

  it("las pérdidas se resumen una vez por minuto, no una línea por lote", async () => {
    vi.useFakeTimers();
    try {
      const { store, updateOne } = storeWith();
      updateOne.mockRejectedValue(new Error("mongo caído"));
      const logger = fakeLogger();
      const history = new MongoHistory(store, logger);

      for (let round = 0; round < 5; round++) {
        for (let m = 1; m <= 10; m++) history.record([entry(round + 1, { matchId: `m-${m}` })]);
        await history.drain();
      }
      // Una línea por partida, la primera vez que pierde algo en la ventana.
      expect(
        vi.mocked(logger.error).mock.calls.filter(([msg]) => msg.includes("lote")),
      ).toHaveLength(10);

      await vi.advanceTimersByTimeAsync(60_000);
      const resumen = vi
        .mocked(logger.error)
        .mock.calls.filter(([msg]) => msg === "historial: se perdieron entradas");
      expect(resumen).toEqual([
        ["historial: se perdieron entradas", { matches: 10, entries: 50, batches: 50 }],
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        vi
          .mocked(logger.error)
          .mock.calls.filter(([msg]) => msg === "historial: se perdieron entradas"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MongoHistory: lectura", () => {
  it("devuelve la timeline de esa partida, con los instantes de vuelta en epoch ms", async () => {
    const entries = [entry(1), entry(2)];
    const { store, findOne } = storeWith({
      matchId: "m-1",
      version: 2.1,
      timeline: entries.map((e) => ({ ...e, at: new Date(e.at) })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await new MongoHistory(store, fakeLogger()).of("m-1")).toEqual(entries);
    expect(findOne).toHaveBeenCalledWith({ matchId: "m-1" }, expect.anything());
  });

  // LA FORMA VIEJA, de antes de la v2.1: `entries` en vez de `timeline`, el `at` como número y sin
  // versión. El endpoint de soporte y el replay la siguen leyendo.
  it("lee también la forma vieja: `entries`, sin versión", async () => {
    const entries = [entry(1), entry(2)];
    const { store } = storeWith({
      matchId: "m-1",
      entries,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await new MongoHistory(store, fakeLogger()).of("m-1")).toEqual(entries);
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

// LA CABECERA Y EL CIERRE VAN POR PIPELINE. Lo que la base hace con él lo mide el contrato contra un
// Mongo de verdad (`./mongo-history.int.test.ts`); acá se miden las DECISIONES que un doble sí ve.
describe("MongoHistory: la cabecera y el cierre", () => {
  it("abre con un upsert por partida, el armado como literal y el arranque como fecha", async () => {
    const { store, updateOne } = storeWith();
    new MongoHistory(store, fakeLogger()).open("m-1", { ...SETUP, matchStartedAt: 1_000 });
    await settle();

    const [filter, pipeline, options] = updateOne.mock.calls[0] ?? [];
    expect(filter).toEqual({ matchId: "m-1" });
    expect(options).toEqual({ upsert: true, timeoutMS: HISTORY_WRITE_TIMEOUT_MS });
    // `$literal`: un nombre de modo que empiece con `$` se leería como un campo del documento.
    const literal = pipeline[0].$replaceWith.$mergeObjects[1].$literal;
    expect(literal).toMatchObject({ status: "started", table: { name: "$peligro" } });
    expect(literal.matchStartedAt).toEqual(new Date(1_000));
  });

  // EL PRIMER CIERRE GANA: sobre un documento ya cerrado el pipeline devuelve el documento como está.
  it("cierra sólo lo que no está cerrado", async () => {
    const { store, updateOne } = storeWith();
    new MongoHistory(store, fakeLogger()).close("m-1", {
      ...SETUP,
      status: "finished",
      matchEndedAt: 2_000,
      matchEndReason: "SCORE",
      winnerIds: [],
      players: [],
      rateId: "r",
      betMultiplier: { offeredValues: [], finalValue: 1, proposals: [] },
      rankingMultiplier: { base: 1, extra: 0, final: 1 },
    });
    await settle();

    const replaceWith = updateOne.mock.calls[0]?.[1][0].$replaceWith;
    const [closedAlready, keep, merged] = replaceWith.$cond;
    expect(closedAlready.$in[1]).toEqual(["finished", "aborted"]);
    expect(keep).toBe("$$ROOT");
    expect(merged.$mergeObjects[2].$literal.matchEndedAt).toEqual(new Date(2_000));
  });

  it("los índices se piden una vez por proceso, y un fallo no frena la escritura", async () => {
    const { store, updateOne, createIndexes } = storeWith();
    createIndexes.mockRejectedValueOnce(new Error("E11000 duplicate key"));
    const logger = fakeLogger();
    const history = new MongoHistory(store, logger);

    // Dos escrituras de verdad: dos lotes del mismo tick viajarían juntos en una.
    history.record([entry(1)]);
    await history.drain();
    history.record([entry(2)]);
    await history.drain();

    // EL ÚNICO VA SOLO: `createIndexes` es todo o nada, y su fallo no puede llevarse los del listado.
    const names = (call: unknown[] | undefined) =>
      (call?.[0] as { name: string }[]).map((index) => index.name);
    expect(createIndexes).toHaveBeenCalledTimes(2);
    expect(names(createIndexes.mock.calls[0])).toEqual(["matchId_1"]);
    expect(names(createIndexes.mock.calls[1])).toEqual([
      "roomId_1_createdAt_-1__id_-1",
      "createdAt_-1__id_-1",
      "seats.userId_1_createdAt_-1__id_-1",
      "matchEndReason_1_createdAt_-1__id_-1",
      "status_1_createdAt_-1__id_-1",
      "matchEndedAt_1_statsPending",
    ]);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("índices"),
      expect.objectContaining({ collection: HISTORY_COLLECTION, indexes: ["matchId_1"] }),
    );
  });

  // UN ÍNDICE QUE TARDA NO FRENA EL HISTORIAL: sobre los millones de partidas de producción, crear uno
  // nuevo lleva minutos, y si el proceso lo esperara antes de escribir, las partidas de ese rato
  // quedarían en memoria hasta que termine. Mongo construye el índice sin trabar la colección.
  it("los índices se crean en segundo plano: uno que nunca termina no frena la escritura", async () => {
    const { store, updateOne, createIndexes } = storeWith();
    createIndexes.mockReturnValue(new Promise(() => {}));
    const history = new MongoHistory(store, fakeLogger());

    history.record([entry(1)]);
    const outcome = await Promise.race([
      history.drain().then(() => "grabado"),
      new Promise((resolve) => setTimeout(() => resolve("colgado"), 200)),
    ]);

    expect(outcome).toBe("grabado");
    expect(createIndexes).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});

// EL PLAZO DEL LISTADO, contra un doble porque un Mongo de verdad no vence a pedido: lo que se mide es
// la DECISIÓN —cada consulta lleva `maxTimeMS`, y vencerlo es `MatchListTimeoutError` y no un error
// cualquiera—. Los planes y los índices se miden contra Mongo en `./mongo-history.int.test.ts`.
describe("MongoHistory: el listado", () => {
  function listingStore(fail?: unknown) {
    const toArray = fail ? vi.fn().mockRejectedValue(fail) : vi.fn().mockResolvedValue([]);
    const find = vi.fn(() => ({ toArray }));
    const countDocuments = vi.fn().mockResolvedValue(0);
    const estimatedDocumentCount = vi.fn().mockResolvedValue(0);
    const createIndexes = vi.fn().mockResolvedValue([]);
    const collection = vi.fn(
      async (_name: string) =>
        ({
          find,
          countDocuments,
          estimatedDocumentCount,
          createIndexes,
        }) as unknown as Collection<never>,
    );
    return {
      store: { collection } as unknown as HistoryStore,
      find,
      countDocuments,
      estimatedDocumentCount,
    };
  }

  const expired = () =>
    new MongoServerError({
      message: "operation exceeded time limit",
      code: 50,
      codeName: "MaxTimeMSExpired",
    });

  it("cada consulta lleva su plazo", async () => {
    const { store, find, countDocuments, estimatedDocumentCount } = listingStore();
    const history = new MongoHistory(store, fakeLogger());

    await history.list({ pageSize: 20 });
    await history.list({ pageSize: 20, roomId: "sala" });

    for (const [, options] of find.mock.calls as unknown as [unknown, { maxTimeMS: number }][])
      expect(options.maxTimeMS).toBe(LIST_MAX_TIME_MS);
    expect(estimatedDocumentCount).toHaveBeenCalledWith({ maxTimeMS: LIST_MAX_TIME_MS });
    expect(countDocuments).toHaveBeenCalledWith(
      { roomId: "sala" },
      { limit: 10_001, maxTimeMS: LIST_MAX_TIME_MS },
    );
  });

  it("un plazo vencido es `MatchListTimeoutError`; otro fallo sube tal cual", async () => {
    await expect(
      new MongoHistory(listingStore(expired()).store, fakeLogger()).list({ pageSize: 20 }),
    ).rejects.toBeInstanceOf(MatchListTimeoutError);

    const other = new Error("conexión cerrada");
    await expect(
      new MongoHistory(listingStore(other).store, fakeLogger()).list({ pageSize: 20 }),
    ).rejects.toBe(other);
  });

  it("también vence el conteo, no sólo la página", async () => {
    const { store, countDocuments } = listingStore();
    countDocuments.mockRejectedValue(expired());

    await expect(
      new MongoHistory(store, fakeLogger()).list({ pageSize: 20, from: new Date(0) }),
    ).rejects.toBeInstanceOf(MatchListTimeoutError);
  });
});
