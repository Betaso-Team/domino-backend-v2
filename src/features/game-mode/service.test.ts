import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Lease } from "../../shared/mongo-lease.js";
import {
  DuplicateGameModeError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "./core/catalog.js";
import type { GameModeOutbox, GameModeOutboxEntry } from "./outbox.js";
import { GameModeService } from "./service.js";
import { MemoryGameModeOutbox } from "./transports/memory-outbox.js";
import { MemoryGameModeRepository } from "./transports/memory-repository.js";
import {
  BASE_INSTANT,
  type MutableClock,
  clasica,
  mutableClock,
} from "./transports/tests/repository-contract.js";

// EL SERVICIO, MEDIDO CONTRA LOS ADAPTADORES DE MEMORIA Y NO CONTRA DOBLES DE LOS PUERTOS, por el
// mismo argumento que `outbox.test.ts`: `MemoryGameModeRepository` y `MemoryGameModeOutbox` son los
// que despliega la instancia sin `MONGO_URI`, así que medir contra ellos mide el sistema. Un doble
// con `create: vi.fn()` mediría que el servicio llama a los métodos que el propio test le enseñó a
// devolver, y las reglas que importan acá —los defaults, la revisión que avanza y la clave de
// deduplicación— viven justamente en el ida y vuelta entre los tres.
//
// Lo único que se escribe a mano son los leases (el que registra y el que niega) y el outbox que
// falla: son desenlaces que ningún adaptador de memoria produce.

// EL NOMBRE Y EL PLAZO SE ESCRIBEN COMO LITERAL y no se importan de `service.ts`: importarlos mediría
// que dos referencias a la misma constante son iguales. El nombre es el contrato con el OTRO
// consumidor del lease —el dispatcher usa `outbox-publisher`—, y escribirlo mal acá es un catálogo
// que se serializa contra el lease equivocado.
const CATALOG_LEASE = "catalog-writer";
const CATALOG_LEASE_TTL_MS = 15_000;

interface Harness {
  readonly service: GameModeService;
  readonly repository: MemoryGameModeRepository;
  readonly outbox: MemoryGameModeOutbox;
  readonly clock: MutableClock;
  readonly taken: ReadonlyArray<{ name: string; ttlMs: number }>;
  readonly wake: ReturnType<typeof vi.fn>;
}

function harness(
  over: { lease?: Lease; outboxOf?: (inner: GameModeOutbox) => GameModeOutbox } = {},
): Harness {
  const clock = mutableClock();
  const repository = new MemoryGameModeRepository(clock);
  const outbox = new MemoryGameModeOutbox(clock);
  const taken: Array<{ name: string; ttlMs: number }> = [];
  const lease: Lease = over.lease ?? {
    async within(name, ttlMs, work) {
      taken.push({ name, ttlMs });
      return work();
    },
  };
  const wake = vi.fn();
  const service = new GameModeService(
    repository,
    over.outboxOf ? over.outboxOf(outbox) : outbox,
    lease,
    wake,
  );
  return { service, repository, outbox, clock, taken, wake };
}

// EL LEASE NEGADO SE ESCRIBE A MANO Y NO SE USA `MemoryLease`, y es la trampa de este archivo:
// `MemoryLease` es pasa-manos y CORRE SIEMPRE —es la semántica correcta para un proceso que no tiene
// a quién excluir—, así que con él la rama de "no lo conseguí" no se puede alcanzar y la aserción
// entera se daría por imposible.
const deniedLease: Lease = {
  async within() {
    return undefined;
  },
};

// EL OUTBOX QUE FALLA DESPUÉS DE QUE MONGO YA CONFIRMÓ: la ventana que la falta de replica set deja
// abierta. Envuelve al de memoria en vez de reemplazarlo para que la reconciliación posterior corra
// contra el almacén DE VERDAD, que es la mitad que el plan pide medir.
function failingOutbox() {
  let failure: Error | undefined;
  return {
    fails(error = new Error("el insert del outbox no llegó")) {
      failure = error;
    },
    recovers() {
      failure = undefined;
    },
    wrap(inner: GameModeOutbox): GameModeOutbox {
      const guard = async (): Promise<void> => {
        if (failure) throw failure;
      };
      return {
        async enqueueCreated(mode) {
          await guard();
          return inner.enqueueCreated(mode);
        },
        async ensureUpdated(mode) {
          await guard();
          return inner.ensureUpdated(mode);
        },
        async sync(modes, batchId) {
          await guard();
          return inner.sync(modes, batchId);
        },
        reconcile: (modes) => inner.reconcile(modes),
        next: (now) => inner.next(now),
        sent: (id, at) => inner.sent(id, at),
        retry: (id, error, at) => inner.retry(id, error, at),
      };
    },
  };
}

// LO ENTREGADO, LEÍDO POR LA ÚNICA VENTANA QUE LA PRODUCCIÓN USA. El puerto no tiene un inspector de
// "todas las entradas" a propósito (ver `transports/tests/outbox-contract.ts`), así que se drena como
// lo hace el dispatcher: tomar el más viejo pendiente y marcarlo entregado.
async function drain(outbox: GameModeOutbox, clock: MutableClock): Promise<GameModeOutboxEntry[]> {
  const delivered: GameModeOutboxEntry[] = [];
  for (;;) {
    const entry = await outbox.next(new Date(clock.now()));
    if (!entry) return delivered;
    delivered.push(entry);
    await outbox.sent(entry.id, new Date(clock.now()));
  }
}

async function keysOf(outbox: GameModeOutbox, clock: MutableClock): Promise<string[]> {
  return (await drain(outbox, clock)).map((entry) => entry.routingKey);
}

describe("GameModeService: lectura", () => {
  it("listActive devuelve sólo los activos y no toma el lease ni encola nada", async () => {
    const { service, repository, outbox, clock, taken, wake } = harness();
    const activa = await repository.create(clasica());
    const retirada = await repository.create(clasica({ name: "Retirada" }));
    await repository.update(retirada.uuid, { isActive: false });

    expect(await service.listActive()).toEqual([activa]);

    expect(taken).toEqual([]);
    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("getActive no ve al modo dado de baja y tampoco toma el lease ni encola", async () => {
    const { service, repository, outbox, clock, taken, wake } = harness();
    const modo = await repository.create(clasica());

    expect(await service.getActive(modo.uuid)).toEqual(modo);

    await repository.update(modo.uuid, { isActive: false });

    // `undefined` Y NO UN THROW, y es lo correcto: desde afuera un modo retirado NO EXISTE, y la
    // frontera HTTP lo convierte en 404. Las mutaciones sí lanzan, porque devuelven `GameMode` a
    // secas y no tienen cómo decir "no estaba".
    expect(await service.getActive(modo.uuid)).toBeUndefined();

    expect(taken).toEqual([]);
    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("GameModeService: create", () => {
  it("aplica los defaults, nace activo en revisión cero y encola el created", async () => {
    const { service, outbox, clock, wake } = harness();

    const creada = await service.create(clasica());

    expect(creada).toEqual({
      id: expect.any(String),
      uuid: expect.any(String),
      name: "Clásica",
      multiplier: 1,
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
      pointsToWin: 25,
      isActive: true,
      isFreeRoom: false,
      enableBots: false,
      createdAt: new Date(BASE_INSTANT),
      updatedAt: new Date(BASE_INSTANT),
      version: 0,
    });

    const [entrada, ...resto] = await drain(outbox, clock);
    expect(resto).toEqual([]);
    expect(entrada?.routingKey).toBe("game_mode.created");
    // El `id` del cuerpo es el `uuid` y no el hex del `_id`. Ver `events.ts`.
    expect(entrada?.payload).toEqual({
      id: creada.uuid,
      game: "domino",
      name: "Clásica",
      isActive: true,
      prize: 18,
      entryFee: 10,
      multiplier: 1,
      pointsToWin: 25,
      playerCount: 2,
    });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("rechaza el par nombre + cantidad repetido, no escribe y no despierta", async () => {
    const { service, repository, outbox, clock, wake } = harness();
    await service.create(clasica());
    await drain(outbox, clock);
    wake.mockClear();

    await expect(service.create(clasica({ prize: 99 }))).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );

    expect(await repository.all()).toHaveLength(1);
    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("acepta el mismo nombre con otra cantidad de jugadores, igual que v1", async () => {
    const { service } = harness();
    await service.create(clasica());

    // La regla de `create` en v1 es nombre + cantidad
    // (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:58`), no nombre a secas: el
    // catálogo productivo puede tener «Clásica» de dos y «Clásica» de cuatro. Una regla más estricta
    // rechazaría modos que el panel crea hoy.
    const cuatro = await service.create(clasica({ playersQuantity: 4 }));

    expect(cuatro.playersQuantity).toBe(4);
    // El default de `enableBots` depende de la cantidad, y acá se ve que el servicio no lo pisa.
    expect(cuatro.enableBots).toBe(true);
  });

  it("serializa dos creaciones concurrentes del MISMO proceso", async () => {
    const { service, repository } = harness();

    // LANZADAS EN EL MISMO TURNO, que es la única forma de medir esto: esperar a que la primera
    // termine deja pasar verde a un servicio sin cola, que es justo el agujero. El lease no alcanza
    // —`MongoLease` excluye PROCESOS y no llamadas—, así que sin la cola en memoria las dos pasan la
    // consulta de duplicados y el catálogo queda con el par repetido que la regla prohíbe.
    const resultados = await Promise.allSettled([
      service.create(clasica()),
      service.create(clasica()),
    ]);

    expect(resultados.map((uno) => uno.status)).toEqual(["fulfilled", "rejected"]);
    const rechazada = resultados[1] as PromiseRejectedResult;
    expect(rechazada.reason).toBeInstanceOf(DuplicateGameModeError);
    expect(await repository.all()).toHaveLength(1);
  });

  it("una mutación que falla NO envenena la cola del proceso", async () => {
    const { service, repository } = harness();
    const creada = await service.create(clasica());

    // LANZADAS EN EL MISMO TURNO, y la primera rechaza a propósito. Lo que se mide es el bug de
    // manual de las colas de promesas: si la cola avanzara con la promesa SIN neutralizar
    // (`this.tail = result` en vez de `result.then(() => undefined, () => undefined)`), quedaría con
    // una promesa rechazada adentro y **toda mutación posterior de este proceso rechazaría para
    // siempre con el error viejo, sin llegar a correr**. O sea un catálogo que se vuelve de sólo
    // lectura —con un `GameModeNotFoundError` de otro request como explicación— hasta que alguien
    // reinicie la instancia. La propiedad estaba escrita en un comentario y no la pineaba nadie.
    const [falla, sigue] = await Promise.allSettled([
      service.update("mode-x", { prize: 1 }),
      service.update(creada.uuid, { prize: 20 }),
    ]);

    expect(falla?.status).toBe("rejected");
    expect(sigue?.status).toBe("fulfilled");
    expect((await repository.byUuid(creada.uuid))?.prize).toBe(20);

    // Y la tercera, ya en otro turno, también entra: la cola queda sana y no sólo "sobrevivió una".
    expect((await service.update(creada.uuid, { prize: 21 })).prize).toBe(21);
  });
});

describe("GameModeService: update", () => {
  it("preserva los campos ausentes, avanza la revisión y encola el updated", async () => {
    const { service, outbox, clock, wake } = harness();
    const creada = await service.create(clasica());
    await drain(outbox, clock);
    wake.mockClear();
    clock.set(BASE_INSTANT + 1_000);

    const editada = await service.update(creada.uuid, { prize: 20 });

    expect(editada).toEqual({
      ...creada,
      prize: 20,
      updatedAt: new Date(BASE_INSTANT + 1_000),
      version: 1,
    });

    const [entrada] = await drain(outbox, clock);
    expect(entrada?.routingKey).toBe("game_mode.updated");
    expect(entrada?.payload.prize).toBe(20);
    expect(entrada?.payload.name).toBe("Clásica");
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("rechaza el nombre de otro modo AUNQUE cambie la cantidad, igual que v1", async () => {
    const { service, repository, outbox, clock } = harness();
    await service.create(clasica());
    const rapida = await service.create(clasica({ name: "Rápida", playersQuantity: 4 }));
    await drain(outbox, clock);

    // LA ASIMETRÍA DE v1, REPRODUCIDA: `update` compara SÓLO el nombre y cruza mesas de dos y de
    // cuatro (`game-mode.service.ts:100-103`), mientras que `create` compara el par. O sea que este
    // renombre está prohibido aunque el par «Clásica»/4 no exista todavía.
    await expect(service.update(rapida.uuid, { name: "Clásica" })).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );

    expect((await repository.byUuid(rapida.uuid))?.name).toBe("Rápida");
    expect(await drain(outbox, clock)).toEqual([]);
  });

  it("deja reenviar el nombre que el modo ya tenía", async () => {
    const { service, outbox, clock } = harness();
    const creada = await service.create(clasica());
    await drain(outbox, clock);

    // v1 sólo consulta duplicados cuando el nombre CAMBIA (`game-mode.service.ts:99`), y el panel
    // manda el cuerpo entero en cada `PUT`: sin esa guarda, todo `PUT` que no toque el nombre
    // chocaría contra el propio modo.
    const editada = await service.update(creada.uuid, { name: "Clásica", pointsToWin: 50 });

    expect(editada.name).toBe("Clásica");
    expect(editada.pointsToWin).toBe(50);
  });

  it("un PUT idéntico avanza igual la revisión y encola otro updated", async () => {
    const { service, outbox, clock } = harness();
    const creada = await service.create(clasica());
    await drain(outbox, clock);

    const primera = await service.update(creada.uuid, { prize: 18 });
    const segunda = await service.update(creada.uuid, { prize: 18 });

    // NO HAY DIFF, y es deliberado: v1 hacía `findOneAndUpdate` y publicaba en CADA `PUT`
    // (`game-mode.service.ts:110-123`), sin comparar contra el documento que había. Ver el
    // comentario de `service.ts`.
    expect([primera.version, segunda.version]).toEqual([1, 2]);
    expect(await keysOf(outbox, clock)).toEqual(["game_mode.updated", "game_mode.updated"]);
  });

  it("lanza not found para un uuid inexistente y no encola", async () => {
    const { service, outbox, clock, wake } = harness();

    await expect(service.update("mode-x", { prize: 1 })).rejects.toBeInstanceOf(
      GameModeNotFoundError,
    );

    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("⚠ HUECO HEREDADO DE v1: un PUT que cambia sólo la cantidad fabrica el par duplicado", async () => {
    const { service, repository } = harness();
    await service.create(clasica());
    const cuatro = await service.create(clasica({ playersQuantity: 4 }));

    // NO LANZA, Y ES v1 AL PIE: la consulta de duplicados de `update` corre SÓLO cuando el nombre
    // cambia (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:99`), así que un cuerpo con
    // el mismo nombre y otra cantidad pasa derecho al `findOneAndUpdate` (`:110`). Acá es la misma
    // línea (`service.ts`, la guarda `input.name !== current.name`).
    await service.update(cuatro.uuid, { playersQuantity: 2 });

    // Y QUEDA EL PAR QUE `create` RECHAZA UNA LÍNEA MÁS ARRIBA.
    expect((await repository.all()).map((modo) => `${modo.name}/${modo.playersQuantity}`)).toEqual([
      "Clásica/2",
      "Clásica/2",
    ]);

    // ⚠ ESTE TEST NO CELEBRA EL HUECO: LO PINEA. Es el comportamiento de v1 reproducido fielmente, y
    // cerrarlo no es una decisión de esta tarea —pide elegir primero cuál de las dos reglas de
    // unicidad vale, la del par (`create`) o la del nombre solo (`update`), y cualquiera de las dos
    // cambia lo que el panel puede hacer hoy—. **El que venga a cambiar la regla de unicidad empieza
    // por acá**: este `it` es el que se va a poner rojo, y ponerlo rojo es lo correcto. Un hueco
    // documentado sin test es un hueco que se ensancha en silencio.
  });
});

describe("GameModeService: baja y reactivación", () => {
  it("el softDelete sólo cambia isActive y encola un updated con isActive false", async () => {
    const { service, outbox, clock, wake } = harness();
    const creada = await service.create(clasica());
    await drain(outbox, clock);
    wake.mockClear();
    clock.set(BASE_INSTANT + 1_000);

    const retirada = await service.softDelete(creada.uuid);

    // El `toEqual` contra el modo entero es lo que mide "SÓLO isActive": un servicio que de paso
    // toque el nombre, el premio o `isFreeRoom` se pone rojo acá y en ningún otro lado.
    expect(retirada).toEqual({
      ...creada,
      isActive: false,
      updatedAt: new Date(BASE_INSTANT + 1_000),
      version: 1,
    });

    const [entrada] = await drain(outbox, clock);
    expect(entrada?.routingKey).toBe("game_mode.updated");
    expect(entrada?.payload.isActive).toBe(false);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("la reactivación sólo cambia isActive y encola un updated con isActive true", async () => {
    const { service, outbox, clock, wake } = harness();
    const creada = await service.create(clasica());
    await service.softDelete(creada.uuid);
    await drain(outbox, clock);
    wake.mockClear();
    clock.set(BASE_INSTANT + 2_000);

    const vuelta = await service.reactivate(creada.uuid);

    expect(vuelta).toEqual({
      ...creada,
      isActive: true,
      updatedAt: new Date(BASE_INSTANT + 2_000),
      version: 2,
    });

    const [entrada] = await drain(outbox, clock);
    expect(entrada?.routingKey).toBe("game_mode.updated");
    expect(entrada?.payload.isActive).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("repetir la baja devuelve el conflicto de estado y no vuelve a escribir", async () => {
    const { service, repository, outbox, clock, wake } = harness();
    const creada = await service.create(clasica());
    await service.softDelete(creada.uuid);
    await drain(outbox, clock);
    wake.mockClear();

    // NO ES "not found" —el modo existe y el panel lo está listando— ni un duplicado. Es el
    // «El modo ya está inactivo» de v1 (`game-mode.service.ts:148-150`), que allá salía como 500 y
    // acá sale como 409.
    await expect(service.softDelete(creada.uuid)).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );

    expect((await repository.byUuid(creada.uuid))?.version).toBe(1);
    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("repetir la reactivación devuelve el conflicto de estado y no vuelve a escribir", async () => {
    const { service, repository, outbox, clock, wake } = harness();
    const creada = await service.create(clasica());
    await drain(outbox, clock);
    wake.mockClear();

    // El gemelo del anterior: «El modo ya está activo» (`game-mode.service.ts:203-205`).
    await expect(service.reactivate(creada.uuid)).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );

    expect((await repository.byUuid(creada.uuid))?.version).toBe(0);
    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("la baja y la reactivación lanzan not found para un uuid inexistente", async () => {
    const { service } = harness();

    await expect(service.softDelete("mode-x")).rejects.toBeInstanceOf(GameModeNotFoundError);
    await expect(service.reactivate("mode-x")).rejects.toBeInstanceOf(GameModeNotFoundError);
  });
});

describe("GameModeService: syncAll", () => {
  it("encola activos e inactivos y devuelve el total", async () => {
    const { service, outbox, clock, wake } = harness();
    const activa = await service.create(clasica());
    const retirada = await service.create(clasica({ name: "Retirada" }));
    await service.softDelete(retirada.uuid);
    await drain(outbox, clock);
    wake.mockClear();

    const resultado = await service.syncAll("lote-1");

    // INCLUYE LOS DADOS DE BAJA, igual que el `/sync` de v1, que llama `getAll()` y no `getAllActive()`
    // (`game-mode.service.ts:177-178`): el botón existe para cuando el consumidor se quedó sin
    // eventos, y un modo retirado del que nunca llegó el `updated` sigue ofreciéndose del otro lado.
    expect(resultado).toEqual({ synced: 2 });

    const entradas = await drain(outbox, clock);
    expect(entradas.map((una) => una.routingKey)).toEqual([
      "game_mode.updated",
      "game_mode.updated",
    ]);
    expect(entradas.map((una) => [una.payload.id, una.payload.isActive])).toEqual(
      expect.arrayContaining([
        [activa.uuid, true],
        [retirada.uuid, false],
      ]),
    );
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("el batchId VIAJA hasta la clave: dos lotes republican todo dos veces", async () => {
    const { service, outbox, clock } = harness();
    const clasicaCreada = await service.create(clasica());
    const rapida = await service.create(clasica({ name: "Rápida" }));
    await drain(outbox, clock);

    expect(await service.syncAll("lote-1")).toEqual({ synced: 2 });
    expect(await keysOf(outbox, clock)).toHaveLength(2);

    // EL SEGUNDO LOTE TIENE QUE REPUBLICAR TODO OTRA VEZ, y esto es un camino de EVENTO PERDIDO y no
    // una aserción de prolijidad. `sync` deduplica por `["game_mode.sync", batchId, uuid]`
    // (`outbox.ts:138-140`), así que un `batchId` que no viaje —uno fijo adentro del servicio, o uno
    // que se olvide de propagarse— hace que el SEGUNDO apretón del botón no encole absolutamente
    // nada mientras contesta `synced: 2`. O sea: el operador aprieta "republicar todo" justamente
    // porque el consumidor se quedó sin eventos, recibe un envelope de éxito, y no se republica uno
    // solo. Nada falla, nada se loguea.
    expect(await service.syncAll("lote-2")).toEqual({ synced: 2 });

    const segundo = await drain(outbox, clock);
    // Las claves se assertan como LITERAL y no reconstruidas con `syncKeyOf`: recalcularlas con la
    // misma función del código mediría que dos llamadas iguales dan lo mismo, y acompañaría un
    // `batchId` fijo sin ponerse roja.
    expect(segundo.map((una) => una.dedupeKey).sort()).toEqual(
      [
        JSON.stringify(["game_mode.sync", "lote-2", clasicaCreada.uuid]),
        JSON.stringify(["game_mode.sync", "lote-2", rapida.uuid]),
      ].sort(),
    );
  });
});

describe("GameModeService: el lease del catálogo", () => {
  it("toma `catalog-writer` por 15 s en TODAS las mutaciones y en ninguna lectura", async () => {
    const { service, taken } = harness();
    const creada = await service.create(clasica());
    await service.update(creada.uuid, { prize: 20 });
    await service.softDelete(creada.uuid);
    await service.reactivate(creada.uuid);
    await service.syncAll("lote-1");
    await service.listActive();
    await service.getActive(creada.uuid);

    expect(taken).toEqual(
      Array.from({ length: 5 }, () => ({ name: CATALOG_LEASE, ttlMs: CATALOG_LEASE_TTL_MS })),
    );
  });

  it("sin lease ninguna escritura ocurre y toda mutación contesta ocupado", async () => {
    const { service, repository, outbox, clock, wake } = harness({ lease: deniedLease });
    // Sembrado POR EL REPOSITORIO y no por el servicio: con el lease negado el servicio no puede
    // crear nada, y hace falta un modo existente para medir que ni siquiera se consulta.
    const modo = await repository.create(clasica());

    await expect(service.create(clasica({ name: "Otra" }))).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.update(modo.uuid, { prize: 99 })).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.softDelete(modo.uuid)).rejects.toBeInstanceOf(GameModeWriteBusyError);
    await expect(service.reactivate(modo.uuid)).rejects.toBeInstanceOf(GameModeWriteBusyError);
    await expect(service.syncAll("lote-1")).rejects.toBeInstanceOf(GameModeWriteBusyError);

    // OCUPADO LE GANA A "no existe" y a "ya está activo": la decisión entera vive ADENTRO del lease,
    // así que un uuid inexistente con el catálogo tomado también contesta 503 y no 404.
    await expect(service.update("mode-x", { prize: 1 })).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.reactivate(modo.uuid)).rejects.toBeInstanceOf(GameModeWriteBusyError);

    expect(await repository.all()).toEqual([modo]);
    expect(await drain(outbox, clock)).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("GameModeService: la ventana modo→outbox", () => {
  it("rechaza si el outbox falla, el cambio QUEDA y la reconciliación emite esa revisión", async () => {
    const outboxFalla = failingOutbox();
    const { service, repository, outbox, clock, wake } = harness({ outboxOf: outboxFalla.wrap });
    const creada = await service.create(clasica());
    // El `created` se da por entregado, como haría el dispatcher: así el `next()` de más abajo
    // devuelve el evento que produjo la reconciliación y no el de la creación.
    await drain(outbox, clock);
    wake.mockClear();
    outboxFalla.fails();

    await expect(service.update(creada.uuid, { prize: 20 })).rejects.toThrow(
      "el insert del outbox no llegó",
    );

    // EL CAMBIO PERMANECE. No hay replica set, así que las dos escrituras no pueden ser atómicas: el
    // panel ve un error y el catálogo ya cambió. Deshacerlo acá sería inventar una transacción.
    const enBase = await repository.byUuid(creada.uuid);
    expect(enBase?.prize).toBe(20);
    expect(enBase?.version).toBe(1);
    expect(await drain(outbox, clock)).toEqual([]);
    // No se despierta al despachador: no hay nada nuevo encolado que apurar.
    expect(wake).not.toHaveBeenCalled();

    // Y EL RECONCILIADOR LO REPARA. Es el tick siguiente del dispatcher (Tarea 7), que compara la
    // revisión del modo contra las claves del outbox.
    outboxFalla.recovers();
    await outbox.reconcile(await repository.all());

    const [entrada, ...resto] = await drain(outbox, clock);
    expect(resto).toEqual([]);
    expect(entrada?.routingKey).toBe("game_mode.updated");
    expect(entrada?.payload).toEqual(expect.objectContaining({ id: creada.uuid, prize: 20 }));
    expect(entrada?.dedupeKey).toBe(JSON.stringify(["game_mode.updated", creada.uuid, 1]));
  });
});

describe("GameModeService: sus dependencias", () => {
  it("no depende de Rabbit: repositorio, outbox y lease, nada más", async () => {
    const source = readFileSync("src/features/game-mode/service.ts", "utf8");
    const imported = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

    // LA LISTA EXACTA Y NO UN "no contiene amqp": con la lista cerrada, toda dependencia IMPORTADA
    // nueva —el publicador, el despachador, el container— tiene que pasar por acá y por el argumento
    // que la justifique.
    //
    // ⚠ **LO QUE ESTA GUARDA NO CUBRE, dicho para no creerle de más**: un quinto parámetro tipado
    // con un tipo ESTRUCTURAL escrito en la línea (`publish: (key: string, body: unknown) =>
    // Promise<void>`) no importa nada, así que pasa verde — medido. Los tipos tampoco lo impiden:
    // nada en TypeScript prohíbe un publicador en el constructor. Esta aserción cubre la forma
    // frecuente —importar el puerto AMQP— y no la estructural, y **no se intenta cubrir la segunda**:
    // el guardarraíl que la atrapara tendría que entender la firma del constructor, y un test que
    // parsea TypeScript miente de otras maneras. Lo que de verdad sostiene la propiedad es el
    // comentario de cabecera de `service.ts` y la revisión; esto es el piso, no el techo.
    expect([...imported].sort()).toEqual([
      "../../shared/mongo-lease.js",
      "./core/catalog.js",
      "./core/game-mode.js",
      "./outbox.js",
    ]);
  });
});
