import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Lease } from "../../shared/mongo-lease.js";
import {
  DuplicateGameModeError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "./core/catalog.js";
import { GameModeService } from "./service.js";
import { MemoryGameModeRepository } from "./transports/memory-repository.js";
import {
  BASE_INSTANT,
  type MutableClock,
  clasica,
  mutableClock,
} from "./transports/tests/repository-contract.test.js";

// EL SERVICIO, MEDIDO CONTRA EL ADAPTADOR DE MEMORIA Y NO CONTRA UN DOBLE DEL PUERTO:
// `MemoryGameModeRepository` es el que despliega la instancia sin `MONGO_URI`, así que medir contra
// él mide el sistema. Un doble con `create: vi.fn()` mediría que el servicio llama a los métodos que
// el propio test le enseñó a devolver, y las reglas que importan acá —los defaults y la revisión que
// avanza— viven justamente en el ida y vuelta entre los dos.
//
// Lo único que se escribe a mano son los leases (el que registra y el que niega): son desenlaces que
// ningún adaptador de memoria produce.

// EL NOMBRE Y EL PLAZO SE ESCRIBEN COMO LITERAL y no se importan de `service.ts`: importarlos mediría
// que dos referencias a la misma constante son iguales.
const CATALOG_LEASE = "catalog-writer";
const CATALOG_LEASE_TTL_MS = 15_000;

interface Harness {
  readonly service: GameModeService;
  readonly repository: MemoryGameModeRepository;
  readonly clock: MutableClock;
  readonly taken: ReadonlyArray<{ name: string; ttlMs: number }>;
}

function harness(over: { lease?: Lease } = {}): Harness {
  const clock = mutableClock();
  const repository = new MemoryGameModeRepository(clock);
  const taken: Array<{ name: string; ttlMs: number }> = [];
  const lease: Lease = over.lease ?? {
    async within(name, ttlMs, work) {
      taken.push({ name, ttlMs });
      return work();
    },
  };
  return { service: new GameModeService(repository, lease), repository, clock, taken };
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

describe("GameModeService: lectura", () => {
  it("listActive devuelve sólo los activos y no toma el lease", async () => {
    const { service, repository, taken } = harness();
    const activa = await repository.create(clasica());
    const retirada = await repository.create(clasica({ name: "Retirada" }));
    await repository.update(retirada.uuid, { isActive: false });

    expect(await service.listActive()).toEqual([activa]);

    expect(taken).toEqual([]);
  });

  it("getActive no ve al modo dado de baja y tampoco toma el lease", async () => {
    const { service, repository, taken } = harness();
    const modo = await repository.create(clasica());

    expect(await service.getActive(modo.uuid)).toEqual(modo);

    await repository.update(modo.uuid, { isActive: false });

    // `undefined` Y NO UN THROW, y es lo correcto: desde afuera un modo retirado NO EXISTE, y la
    // frontera HTTP lo convierte en 404. Las mutaciones sí lanzan, porque devuelven `GameMode` a
    // secas y no tienen cómo decir "no estaba".
    expect(await service.getActive(modo.uuid)).toBeUndefined();

    expect(taken).toEqual([]);
  });
});

describe("GameModeService: create", () => {
  it("aplica los defaults y nace activo en revisión cero", async () => {
    const { service } = harness();

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
  });

  it("rechaza el par nombre + cantidad repetido y no escribe", async () => {
    const { service, repository } = harness();
    await service.create(clasica());

    await expect(service.create(clasica({ prize: 99 }))).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );

    expect(await repository.all()).toHaveLength(1);
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
  it("preserva los campos ausentes y avanza la revisión", async () => {
    const { service, clock } = harness();
    const creada = await service.create(clasica());
    clock.set(BASE_INSTANT + 1_000);

    const editada = await service.update(creada.uuid, { prize: 20 });

    expect(editada).toEqual({
      ...creada,
      prize: 20,
      updatedAt: new Date(BASE_INSTANT + 1_000),
      version: 1,
    });
  });

  it("rechaza el nombre de otro modo AUNQUE cambie la cantidad, igual que v1", async () => {
    const { service, repository } = harness();
    await service.create(clasica());
    const rapida = await service.create(clasica({ name: "Rápida", playersQuantity: 4 }));

    // LA ASIMETRÍA DE v1, REPRODUCIDA: `update` compara SÓLO el nombre y cruza mesas de dos y de
    // cuatro (`game-mode.service.ts:100-103`), mientras que `create` compara el par. O sea que este
    // renombre está prohibido aunque el par «Clásica»/4 no exista todavía.
    await expect(service.update(rapida.uuid, { name: "Clásica" })).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );

    expect((await repository.byUuid(rapida.uuid))?.name).toBe("Rápida");
  });

  it("deja reenviar el nombre que el modo ya tenía", async () => {
    const { service } = harness();
    const creada = await service.create(clasica());

    // v1 sólo consulta duplicados cuando el nombre CAMBIA (`game-mode.service.ts:99`), y el panel
    // manda el cuerpo entero en cada `PUT`: sin esa guarda, todo `PUT` que no toque el nombre
    // chocaría contra el propio modo.
    const editada = await service.update(creada.uuid, { name: "Clásica", pointsToWin: 50 });

    expect(editada.name).toBe("Clásica");
    expect(editada.pointsToWin).toBe(50);
  });

  it("un PUT idéntico avanza igual la revisión", async () => {
    const { service } = harness();
    const creada = await service.create(clasica());

    const primera = await service.update(creada.uuid, { prize: 18 });
    const segunda = await service.update(creada.uuid, { prize: 18 });

    // NO HAY DIFF, y es deliberado: v1 hacía `findOneAndUpdate` y publicaba en CADA `PUT`
    // (`game-mode.service.ts:110-123`), sin comparar contra el documento que había. Ver el
    // comentario de `service.ts`.
    expect([primera.version, segunda.version]).toEqual([1, 2]);
  });

  it("lanza not found para un uuid inexistente", async () => {
    const { service } = harness();

    await expect(service.update("mode-x", { prize: 1 })).rejects.toBeInstanceOf(
      GameModeNotFoundError,
    );
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
  it("el softDelete sólo cambia isActive", async () => {
    const { service, clock } = harness();
    const creada = await service.create(clasica());
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
  });

  it("la reactivación sólo cambia isActive", async () => {
    const { service, clock } = harness();
    const creada = await service.create(clasica());
    await service.softDelete(creada.uuid);
    clock.set(BASE_INSTANT + 2_000);

    const vuelta = await service.reactivate(creada.uuid);

    expect(vuelta).toEqual({
      ...creada,
      isActive: true,
      updatedAt: new Date(BASE_INSTANT + 2_000),
      version: 2,
    });
  });

  it("repetir la baja devuelve el conflicto de estado y no vuelve a escribir", async () => {
    const { service, repository } = harness();
    const creada = await service.create(clasica());
    await service.softDelete(creada.uuid);

    // NO ES "not found" —el modo existe y el panel lo está listando— ni un duplicado. Es el
    // «El modo ya está inactivo» de v1 (`game-mode.service.ts:148-150`), que allá salía como 500 y
    // acá sale como 409.
    await expect(service.softDelete(creada.uuid)).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );

    expect((await repository.byUuid(creada.uuid))?.version).toBe(1);
  });

  it("repetir la reactivación devuelve el conflicto de estado y no vuelve a escribir", async () => {
    const { service, repository } = harness();
    const creada = await service.create(clasica());

    // El gemelo del anterior: «El modo ya está activo» (`game-mode.service.ts:203-205`).
    await expect(service.reactivate(creada.uuid)).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );

    expect((await repository.byUuid(creada.uuid))?.version).toBe(0);
  });

  it("la baja y la reactivación lanzan not found para un uuid inexistente", async () => {
    const { service } = harness();

    await expect(service.softDelete("mode-x")).rejects.toBeInstanceOf(GameModeNotFoundError);
    await expect(service.reactivate("mode-x")).rejects.toBeInstanceOf(GameModeNotFoundError);
  });
});

describe("GameModeService: el lease del catálogo", () => {
  it("toma `catalog-writer` por 15 s en TODAS las mutaciones y en ninguna lectura", async () => {
    const { service, taken } = harness();
    const creada = await service.create(clasica());
    await service.update(creada.uuid, { prize: 20 });
    await service.softDelete(creada.uuid);
    await service.reactivate(creada.uuid);
    await service.listActive();
    await service.getActive(creada.uuid);

    expect(taken).toEqual(
      Array.from({ length: 4 }, () => ({ name: CATALOG_LEASE, ttlMs: CATALOG_LEASE_TTL_MS })),
    );
  });

  it("sin lease ninguna escritura ocurre y toda mutación contesta ocupado", async () => {
    const { service, repository } = harness({ lease: deniedLease });
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

    // OCUPADO LE GANA A "no existe" y a "ya está activo": la decisión entera vive ADENTRO del lease,
    // así que un uuid inexistente con el catálogo tomado también contesta 503 y no 404.
    await expect(service.update("mode-x", { prize: 1 })).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.reactivate(modo.uuid)).rejects.toBeInstanceOf(GameModeWriteBusyError);

    expect(await repository.all()).toEqual([modo]);
  });
});

describe("GameModeService: sus dependencias", () => {
  it("el servicio importa el repositorio y el lease, nada más", async () => {
    const source = readFileSync("src/features/game-mode/service.ts", "utf8");
    const imported = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

    // LA LISTA EXACTA Y NO UN "no contiene X": con la lista cerrada, toda dependencia IMPORTADA
    // nueva —un cliente de otro servicio, el container— tiene que pasar por acá y por el argumento
    // que la justifique. El catálogo se lee y se escribe contra la base y nada más.
    //
    // ⚠ Un parámetro tipado con un tipo ESTRUCTURAL escrito en la línea no importa nada, así que
    // pasa verde — medido. Esta aserción cubre la forma frecuente y no la estructural; el piso, no
    // el techo.
    expect([...imported].sort()).toEqual([
      "../../shared/mongo-lease.js",
      "./core/catalog.js",
      "./core/game-mode.js",
    ]);
  });
});
