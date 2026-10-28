import { readFileSync } from "node:fs";
import type { Lease } from "@/shared/mongo-lease";
import { describe, expect, it } from "vitest";
import {
  DuplicateGameModeError,
  FreeRoomWithEntryError,
  BETASO_GAMES as GAMES,
  GameModeForbiddenError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "./core/catalog";
import type { GameMode } from "./core/game-mode";
import { GameModeService } from "./service";
import { MemoryGameModeRepository } from "./transports/memory-repository";
import {
  BASE_INSTANT,
  type MutableClock,
  clasica,
  mutableClock,
} from "./transports/tests/repository-contract";

// EL SERVICIO, MEDIDO CONTRA EL ADAPTADOR DE MEMORIA Y NO CONTRA DOBLES DEL PUERTO:
// `MemoryGameModeRepository` es el que despliega la instancia sin `MONGO_URI`, así que medir contra
// él mide el sistema. Lo único que se escribe a mano son los leases (el que registra y el que niega):
// son desenlaces que ningún adaptador de memoria produce.

// EL NOMBRE Y EL PLAZO SE ESCRIBEN COMO LITERAL y no se importan de `service.ts`: importarlos mediría
// que dos referencias a la misma constante son iguales. El nombre es el contrato con el OTRO
// consumidor del lease —el despachador de resultados usa `match-result-publisher`—, y escribirlo mal
// acá es un catálogo que se serializa contra el lease equivocado.
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
  const service = new GameModeService(repository, lease);
  return { service, repository, clock, taken };
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
  it("listPublic devuelve sólo los activos y no toma el lease", async () => {
    const { service, repository, clock, taken } = harness();
    const activa = await repository.create(clasica());
    const retirada = await repository.create(clasica({ name: "Retirada" }));
    await repository.update(retirada.uuid, { isActive: false });

    expect(await service.listPublic()).toEqual([activa]);

    expect(taken).toEqual([]);
  });

  it("getPublic no ve al modo dado de baja y tampoco toma el lease", async () => {
    const { service, repository, clock, taken } = harness();
    const modo = await repository.create(clasica());

    expect(await service.getPublic(modo.uuid)).toEqual(modo);

    await repository.update(modo.uuid, { isActive: false });

    // `undefined` Y NO UN THROW, y es lo correcto: desde afuera un modo retirado NO EXISTE, y la
    // frontera HTTP lo convierte en 404. Las mutaciones sí lanzan, porque devuelven `GameMode` a
    // secas y no tienen cómo decir "no estaba".
    expect(await service.getPublic(modo.uuid)).toBeUndefined();

    expect(taken).toEqual([]);
  });

  // LO QUE VE EL PANEL: reactivar exige poder listar al retirado primero. Mismo armado que
  // `listPublic`, pero acá el orden es el del repositorio (recientes primero).
  it("listFor de Betaso Games devuelve activos e inactivos y no toma el lease", async () => {
    const { service, repository, clock, taken } = harness();
    const activa = await repository.create(clasica());
    clock.set(clock.now() + 1000);
    const retirada = await repository.create(clasica({ name: "Retirada" }));
    await repository.update(retirada.uuid, { isActive: false });

    expect(await service.listFor(GAMES)).toEqual([await repository.byUuid(retirada.uuid), activa]);

    expect(taken).toEqual([]);
  });

  it("getFor de Betaso Games ve al modo dado de baja y tampoco toma el lease", async () => {
    const { service, repository, clock, taken } = harness();
    const modo = await repository.create(clasica());
    await repository.update(modo.uuid, { isActive: false });

    expect(await service.getFor(GAMES, modo.uuid)).toEqual(await repository.byUuid(modo.uuid));
    expect((await service.getFor(GAMES, modo.uuid))?.isActive).toBe(false);
    expect(await service.getFor(GAMES, "no-existe")).toBeUndefined();

    expect(taken).toEqual([]);
  });
});

describe("GameModeService: create", () => {
  it("aplica los defaults, nace activo en revisión cero", async () => {
    const { service, clock } = harness();

    const creada = await service.create(GAMES, clasica());

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
      betLevels: [],
      // Betaso Games sin dueño en el cuerpo: un COMPARTIDO, que nace sin nadie suscrito.
      ownerProviderId: null,
      subscribers: [],
      createdAt: new Date(BASE_INSTANT),
      updatedAt: new Date(BASE_INSTANT),
      version: 0,
    });
  });

  it("rechaza el par nombre + cantidad repetido y no escribe", async () => {
    const { service, repository, clock } = harness();
    await service.create(GAMES, clasica());

    await expect(service.create(GAMES, clasica({ prize: 99 }))).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );

    expect(await repository.all()).toHaveLength(1);
  });

  it("rechaza la mesa gratis que cobra entrada y no escribe", async () => {
    const { service, repository, clock } = harness();

    await expect(
      service.create(GAMES, clasica({ isFreeRoom: true, entryFee: 10 })),
    ).rejects.toBeInstanceOf(FreeRoomWithEntryError);

    expect(await repository.all()).toEqual([]);
  });

  it("acepta la mesa gratis sin entrada", async () => {
    const { service } = harness();

    const creada = await service.create(GAMES, clasica({ isFreeRoom: true, entryFee: 0 }));

    expect(creada).toMatchObject({ isFreeRoom: true, entryFee: 0 });
  });

  it("acepta el mismo nombre con otra cantidad de jugadores, igual que v1", async () => {
    const { service } = harness();
    await service.create(GAMES, clasica());

    // La regla de `create` en v1 es nombre + cantidad
    // (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:58`), no nombre a secas: el
    // catálogo productivo puede tener «Clásica» de dos y «Clásica» de cuatro. Una regla más estricta
    // rechazaría modos que el panel crea hoy.
    const cuatro = await service.create(GAMES, clasica({ playersQuantity: 4 }));

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
      service.create(GAMES, clasica()),
      service.create(GAMES, clasica()),
    ]);

    expect(resultados.map((uno) => uno.status)).toEqual(["fulfilled", "rejected"]);
    const rechazada = resultados[1] as PromiseRejectedResult;
    expect(rechazada.reason).toBeInstanceOf(DuplicateGameModeError);
    expect(await repository.all()).toHaveLength(1);
  });

  it("una mutación que falla NO envenena la cola del proceso", async () => {
    const { service, repository } = harness();
    const creada = await service.create(GAMES, clasica());

    // LANZADAS EN EL MISMO TURNO, y la primera rechaza a propósito. Lo que se mide es el bug de
    // manual de las colas de promesas: si la cola avanzara con la promesa SIN neutralizar
    // (`this.tail = result` en vez de `result.then(() => undefined, () => undefined)`), quedaría con
    // una promesa rechazada adentro y **toda mutación posterior de este proceso rechazaría para
    // siempre con el error viejo, sin llegar a correr**. O sea un catálogo que se vuelve de sólo
    // lectura —con un `GameModeNotFoundError` de otro request como explicación— hasta que alguien
    // reinicie la instancia. La propiedad estaba escrita en un comentario y no la pineaba nadie.
    const [falla, sigue] = await Promise.allSettled([
      service.update(GAMES, "mode-x", { prize: 1 }),
      service.update(GAMES, creada.uuid, { prize: 20 }),
    ]);

    expect(falla?.status).toBe("rejected");
    expect(sigue?.status).toBe("fulfilled");
    expect((await repository.byUuid(creada.uuid))?.prize).toBe(20);

    // Y la tercera, ya en otro turno, también entra: la cola queda sana y no sólo "sobrevivió una".
    expect((await service.update(GAMES, creada.uuid, { prize: 21 })).prize).toBe(21);
  });
});

describe("GameModeService: update", () => {
  it("preserva los campos ausentes y avanza la revisión", async () => {
    const { service, clock } = harness();
    const creada = await service.create(GAMES, clasica());
    clock.set(BASE_INSTANT + 1_000);

    const editada = await service.update(GAMES, creada.uuid, { prize: 20 });

    expect(editada).toEqual({
      ...creada,
      prize: 20,
      updatedAt: new Date(BASE_INSTANT + 1_000),
      version: 1,
    });
  });

  it.each([
    ["le pone entrada a una mesa gratis", { isFreeRoom: true, entryFee: 0 }, { entryFee: 10 }],
    ["marca gratis una mesa que cobra", { entryFee: 10 }, { isFreeRoom: true }],
  ])("rechaza el PUT que %s y no escribe", async (_label, seed, patch) => {
    const { service, repository } = harness();
    const creada = await service.create(GAMES, clasica(seed));

    await expect(service.update(GAMES, creada.uuid, patch)).rejects.toBeInstanceOf(
      FreeRoomWithEntryError,
    );

    expect(await repository.byUuid(creada.uuid)).toEqual(creada);
  });

  it("deja apagar la mesa gratis y cobrar en el mismo PUT", async () => {
    const { service } = harness();
    const creada = await service.create(GAMES, clasica({ isFreeRoom: true, entryFee: 0 }));

    const editada = await service.update(GAMES, creada.uuid, { isFreeRoom: false, entryFee: 10 });

    expect(editada).toMatchObject({ isFreeRoom: false, entryFee: 10 });
  });

  // UN MODO QUE YA ERA CONTRADICTORIO —el catálogo es el de v1, y v1 no lo impedía— se sigue pudiendo
  // editar en lo que no toca a la regla: bloquearle el premio no lo arregla, sólo traba al panel.
  it("no traba el PUT ajeno a la regla sobre un modo que ya era contradictorio", async () => {
    const { service, repository } = harness();
    const heredado = await repository.create(clasica({ isFreeRoom: true, entryFee: 10 }));

    const editado = await service.update(GAMES, heredado.uuid, { prize: 20 });

    expect(editado.prize).toBe(20);
  });

  it("rechaza el nombre de otro modo AUNQUE cambie la cantidad, igual que v1", async () => {
    const { service, repository, clock } = harness();
    await service.create(GAMES, clasica());
    const rapida = await service.create(GAMES, clasica({ name: "Rápida", playersQuantity: 4 }));

    // LA ASIMETRÍA DE v1, REPRODUCIDA: `update` compara SÓLO el nombre y cruza mesas de dos y de
    // cuatro (`game-mode.service.ts:100-103`), mientras que `create` compara el par. O sea que este
    // renombre está prohibido aunque el par «Clásica»/4 no exista todavía.
    await expect(service.update(GAMES, rapida.uuid, { name: "Clásica" })).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );

    expect((await repository.byUuid(rapida.uuid))?.name).toBe("Rápida");
  });

  it("deja reenviar el nombre que el modo ya tenía", async () => {
    const { service, clock } = harness();
    const creada = await service.create(GAMES, clasica());

    // v1 sólo consulta duplicados cuando el nombre CAMBIA (`game-mode.service.ts:99`), y el panel
    // manda el cuerpo entero en cada `PUT`: sin esa guarda, todo `PUT` que no toque el nombre
    // chocaría contra el propio modo.
    const editada = await service.update(GAMES, creada.uuid, { name: "Clásica", pointsToWin: 50 });

    expect(editada.name).toBe("Clásica");
    expect(editada.pointsToWin).toBe(50);
  });

  it("un PUT idéntico avanza igual la revisión", async () => {
    const { service, clock } = harness();
    const creada = await service.create(GAMES, clasica());

    const primera = await service.update(GAMES, creada.uuid, { prize: 18 });
    const segunda = await service.update(GAMES, creada.uuid, { prize: 18 });

    // NO HAY DIFF, y es deliberado: v1 hacía `findOneAndUpdate` y publicaba en CADA `PUT`
    // (`game-mode.service.ts:110-123`), sin comparar contra el documento que había. Ver el
    // comentario de `service.ts`.
    expect([primera.version, segunda.version]).toEqual([1, 2]);
  });

  it("lanza not found para un uuid inexistente", async () => {
    const { service, clock } = harness();

    await expect(service.update(GAMES, "mode-x", { prize: 1 })).rejects.toBeInstanceOf(
      GameModeNotFoundError,
    );
  });

  it("⚠ HUECO HEREDADO DE v1: un PUT que cambia sólo la cantidad fabrica el par duplicado", async () => {
    const { service, repository } = harness();
    await service.create(GAMES, clasica());
    const cuatro = await service.create(GAMES, clasica({ playersQuantity: 4 }));

    // NO LANZA, Y ES v1 AL PIE: la consulta de duplicados de `update` corre SÓLO cuando el nombre
    // cambia (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:99`), así que un cuerpo con
    // el mismo nombre y otra cantidad pasa derecho al `findOneAndUpdate` (`:110`). Acá es la misma
    // línea (`service.ts`, la guarda `input.name !== current.name`).
    await service.update(GAMES, cuatro.uuid, { playersQuantity: 2 });

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
    const creada = await service.create(GAMES, clasica());
    clock.set(BASE_INSTANT + 1_000);

    const retirada = await service.softDelete(GAMES, creada.uuid);

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
    const creada = await service.create(GAMES, clasica());
    await service.softDelete(GAMES, creada.uuid);
    clock.set(BASE_INSTANT + 2_000);

    const vuelta = await service.reactivate(GAMES, creada.uuid);

    expect(vuelta).toEqual({
      ...creada,
      isActive: true,
      updatedAt: new Date(BASE_INSTANT + 2_000),
      version: 2,
    });
  });

  it("repetir la baja devuelve el conflicto de estado y no vuelve a escribir", async () => {
    const { service, repository, clock } = harness();
    const creada = await service.create(GAMES, clasica());
    await service.softDelete(GAMES, creada.uuid);

    // NO ES "not found" —el modo existe y el panel lo está listando— ni un duplicado. Es el
    // «El modo ya está inactivo» de v1 (`game-mode.service.ts:148-150`), que allá salía como 500 y
    // acá sale como 409.
    await expect(service.softDelete(GAMES, creada.uuid)).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );

    expect((await repository.byUuid(creada.uuid))?.version).toBe(1);
  });

  it("repetir la reactivación devuelve el conflicto de estado y no vuelve a escribir", async () => {
    const { service, repository, clock } = harness();
    const creada = await service.create(GAMES, clasica());

    // El gemelo del anterior: «El modo ya está activo» (`game-mode.service.ts:203-205`).
    await expect(service.reactivate(GAMES, creada.uuid)).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );

    expect((await repository.byUuid(creada.uuid))?.version).toBe(0);
  });

  it("la baja y la reactivación lanzan not found para un uuid inexistente", async () => {
    const { service } = harness();

    await expect(service.softDelete(GAMES, "mode-x")).rejects.toBeInstanceOf(GameModeNotFoundError);
    await expect(service.reactivate(GAMES, "mode-x")).rejects.toBeInstanceOf(GameModeNotFoundError);
  });
});

describe("GameModeService: el lease del catálogo", () => {
  it("toma `catalog-writer` por 15 s en TODAS las mutaciones y en ninguna lectura", async () => {
    const { service, taken } = harness();
    const creada = await service.create(GAMES, clasica());
    await service.update(GAMES, creada.uuid, { prize: 20 });
    await service.softDelete(GAMES, creada.uuid);
    await service.reactivate(GAMES, creada.uuid);
    await service.listPublic();
    await service.getPublic(creada.uuid);
    await service.listFor(GAMES);
    await service.getFor(GAMES, creada.uuid);

    expect(taken).toEqual(
      Array.from({ length: 4 }, () => ({ name: CATALOG_LEASE, ttlMs: CATALOG_LEASE_TTL_MS })),
    );
  });

  it("sin lease ninguna escritura ocurre y toda mutación contesta ocupado", async () => {
    const { service, repository, clock } = harness({ lease: deniedLease });
    // Sembrado POR EL REPOSITORIO y no por el servicio: con el lease negado el servicio no puede
    // crear nada, y hace falta un modo existente para medir que ni siquiera se consulta.
    const modo = await repository.create(clasica());

    await expect(service.create(GAMES, clasica({ name: "Otra" }))).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.update(GAMES, modo.uuid, { prize: 99 })).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.softDelete(GAMES, modo.uuid)).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.reactivate(GAMES, modo.uuid)).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );

    // OCUPADO LE GANA A "no existe" y a "ya está activo": la decisión entera vive ADENTRO del lease,
    // así que un uuid inexistente con el catálogo tomado también contesta 503 y no 404.
    await expect(service.update(GAMES, "mode-x", { prize: 1 })).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.reactivate(GAMES, modo.uuid)).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );

    expect(await repository.all()).toEqual([modo]);
  });
});

describe("GameModeService: sus dependencias", () => {
  it("no depende de ningún broker: repositorio y lease, nada más", async () => {
    const source = readFileSync("src/features/game-mode/service.ts", "utf8");
    const imported = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

    // LA LISTA EXACTA Y NO UN "no contiene amqp": con la lista cerrada, toda dependencia IMPORTADA
    // nueva —un publicador, un outbox, el container— tiene que pasar por acá y por el argumento que
    // la justifique. El catálogo dejó de publicar al exchange `betaso`: que no vuelva por la puerta
    // de atrás.
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
      // El uuid determinista de la copia a un operador: `node:crypto` y nada más.
      "./copy-uuid",
      "./core/catalog",
      "./core/game-mode",
      // CON `@/` Y SIN EXTENSIÓN, que es la convención del repo: el alias marca que el import SALE
      // del módulo. La lista sigue siendo exacta, y de paso esto es lo que hace que la convención
      // no se pueda abandonar de a un archivo sin que algo se ponga rojo.
      "@/shared/mongo-lease",
    ]);
  });
});

// ═══ LOS OPERADORES ═══════════════════════════════════════════════════════════════════════════════
// Modos con dueño, suscripciones y la copia de los compartidos. Los actores son los que dejaría
// pasar la puerta HTTP: Betaso Games (`GAMES`) y dos operadores que no se ven entre sí.
const PARLEY = { provider: "parley" } as const;
const RIVAL = { provider: "rival" } as const;

// UN COMPARTIDO LEGADO, como los deja v1. Ningún adaptador sabe crear uno —todo modo nuevo nace con
// lista—, así que se le borra la lista al arreglo interno del de memoria.
function makeLegacy(repository: MemoryGameModeRepository, uuid: string): void {
  const modes = (repository as unknown as { modes: Array<{ uuid: string; subscribers: unknown }> })
    .modes;
  const stored = modes.find((mode) => mode.uuid === uuid);
  if (stored) stored.subscribers = null;
}

async function legacy(
  repository: MemoryGameModeRepository,
  over: Parameters<typeof clasica>[0] = {},
): Promise<GameMode> {
  const mode = await repository.create(clasica(over));
  makeLegacy(repository, mode.uuid);
  return (await repository.byUuid(mode.uuid)) as GameMode;
}

const ownedBy = async (repository: MemoryGameModeRepository, provider: string) =>
  (await repository.all()).filter((mode) => mode.ownerProviderId === provider);

describe("GameModeService: el dueño de un modo nuevo", () => {
  it("un operador crea un modo propio suyo, sin mandar el campo o mandándolo", async () => {
    const { service } = harness();

    const sinCampo = await service.create(PARLEY, clasica());
    const conCampo = await service.create(
      PARLEY,
      clasica({ name: "Otra", ownerProviderId: "parley" }),
    );

    expect(sinCampo).toMatchObject({ ownerProviderId: "parley", subscribers: [] });
    expect(conCampo.ownerProviderId).toBe("parley");
  });

  it.each([
    ["para otro operador", "rival"],
    ["compartido", null],
  ])("un operador no crea un modo %s, y no se escribe nada", async (_label, owner) => {
    const { service, repository } = harness();

    await expect(
      service.create(PARLEY, clasica({ ownerProviderId: owner })),
    ).rejects.toBeInstanceOf(GameModeForbiddenError);
    expect(await repository.all()).toEqual([]);
  });

  it("Betaso Games crea compartidos por default y propios del operador que nombre", async () => {
    const { service } = harness();

    expect((await service.create(GAMES, clasica())).ownerProviderId).toBeNull();
    const propio = await service.create(GAMES, clasica({ ownerProviderId: "parley" }));
    expect(propio.ownerProviderId).toBe("parley");
  });
});

describe("GameModeService: la unicidad por dueño", () => {
  it("el mismo par nombre + cantidad convive entre dueños y se rechaza dentro de uno", async () => {
    const { service } = harness();
    await service.create(GAMES, clasica());

    await service.create(PARLEY, clasica());
    await service.create(RIVAL, clasica());

    await expect(service.create(PARLEY, clasica({ prize: 99 }))).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );
    await expect(service.create(GAMES, clasica({ prize: 99 }))).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );
  });

  // LA ASIMETRÍA DE v1 SE CONSERVA DENTRO DE CADA DUEÑO: `update` compara sólo el nombre, cruzando
  // mesas de dos y de cuatro, pero sólo contra los modos del mismo dueño.
  it("renombrar choca por nombre solo, y sólo con los modos del mismo dueño", async () => {
    const { service } = harness();
    await service.create(GAMES, clasica({ name: "Compartida" }));
    await service.create(PARLEY, clasica());
    const rapida = await service.create(PARLEY, clasica({ name: "Rápida", playersQuantity: 4 }));

    await expect(service.update(PARLEY, rapida.uuid, { name: "Clásica" })).rejects.toBeInstanceOf(
      DuplicateGameModeError,
    );
    const renombrada = await service.update(PARLEY, rapida.uuid, { name: "Compartida" });
    expect(renombrada.name).toBe("Compartida");
  });

  // EL HUECO HEREDADO, POR DUEÑO: el mismo `PUT` de sólo la cantidad, en los modos de un operador.
  it("⚠ HUECO HEREDADO DE v1, también dentro de un operador", async () => {
    const { service, repository } = harness();
    await service.create(PARLEY, clasica());
    const cuatro = await service.create(PARLEY, clasica({ playersQuantity: 4 }));

    await service.update(PARLEY, cuatro.uuid, { playersQuantity: 2 });

    expect(
      (await ownedBy(repository, "parley")).map((modo) => `${modo.name}/${modo.playersQuantity}`),
    ).toEqual(["Clásica/2", "Clásica/2"]);
  });
});

describe("GameModeService: lo que ve y toca cada operador", () => {
  async function catalog() {
    const h = harness();
    const viejo = await legacy(h.repository, { name: "Legado" });
    const suscrito = await h.repository.create(clasica({ name: "Suscrito" }));
    await h.repository.addSubscriber(suscrito.uuid, "parley");
    const ajeno = await h.repository.create(clasica({ name: "De otros" }));
    await h.repository.addSubscriber(ajeno.uuid, "rival");
    const propio = await h.repository.create(
      clasica({ name: "Propio", ownerProviderId: "parley" }),
    );
    const delRival = await h.repository.create(
      clasica({ name: "Del rival", ownerProviderId: "rival" }),
    );
    return { ...h, viejo, suscrito, ajeno, propio, delRival };
  }

  it("un operador ve los suyos y los compartidos que juega; Betaso Games ve todo", async () => {
    const { service } = await catalog();

    const names = async (actor: { provider: string | null }) =>
      (await service.listFor(actor)).map((modo) => modo.name).sort();

    expect(await names(PARLEY)).toEqual(["Legado", "Propio", "Suscrito"]);
    expect(await names(RIVAL)).toEqual(["De otros", "Del rival", "Legado"]);
    expect(await names(GAMES)).toEqual(["De otros", "Del rival", "Legado", "Propio", "Suscrito"]);
  });

  it("getFor no le muestra a un operador lo que no ve", async () => {
    const { service, delRival, ajeno, propio } = await catalog();

    expect(await service.getFor(PARLEY, delRival.uuid)).toBeUndefined();
    expect(await service.getFor(PARLEY, ajeno.uuid)).toBeUndefined();
    expect((await service.getFor(PARLEY, propio.uuid))?.name).toBe("Propio");
  });

  it("el público ve sólo los compartidos activos, y el orquestador todo", async () => {
    const { service, repository, suscrito, propio } = await catalog();
    await repository.update(suscrito.uuid, { isActive: false });

    expect((await service.listPublic()).map((modo) => modo.name).sort()).toEqual([
      "De otros",
      "Legado",
    ]);
    expect(await service.getPublic(propio.uuid)).toBeUndefined();
    expect(await service.listInternal({ includeInactive: false })).toHaveLength(4);
    expect(await service.listInternal({ includeInactive: true })).toHaveLength(5);
  });

  it("un operador edita, da de baja y reactiva los suyos", async () => {
    const { service, propio } = await catalog();

    expect((await service.update(PARLEY, propio.uuid, { prize: 30 })).prize).toBe(30);
    expect((await service.softDelete(PARLEY, propio.uuid)).isActive).toBe(false);
    expect((await service.reactivate(PARLEY, propio.uuid)).isActive).toBe(true);
  });

  // 403 SOBRE UN COMPARTIDO —es público— Y 404 SOBRE EL PROPIO DE OTRO, que no puede saber que existe.
  it("un compartido es 403 y el propio de otro operador es 404, en las tres escrituras", async () => {
    const { service, repository, viejo, ajeno, delRival } = await catalog();
    const antes = await repository.all();

    for (const write of [
      (uuid: string) => service.update(PARLEY, uuid, { prize: 1 }),
      (uuid: string) => service.softDelete(PARLEY, uuid),
      (uuid: string) => service.reactivate(PARLEY, uuid),
    ]) {
      await expect(write(viejo.uuid)).rejects.toBeInstanceOf(GameModeForbiddenError);
      await expect(write(ajeno.uuid)).rejects.toBeInstanceOf(GameModeForbiddenError);
      await expect(write(delRival.uuid)).rejects.toBeInstanceOf(GameModeNotFoundError);
    }
    expect(await repository.all()).toEqual(antes);
  });
});

describe("GameModeService: las suscripciones", () => {
  it("un operador se suscribe y se da de baja, sin revisión", async () => {
    const { service, repository, clock } = harness();
    const modo = await service.create(GAMES, clasica());

    expect((await service.subscribe(PARLEY, modo.uuid, "parley")).subscribers).toEqual(["parley"]);
    expect((await service.subscribe(GAMES, modo.uuid, "rival")).subscribers).toEqual([
      "parley",
      "rival",
    ]);
    expect((await service.unsubscribe(PARLEY, modo.uuid, "parley")).subscribers).toEqual(["rival"]);

    expect((await repository.byUuid(modo.uuid))?.version).toBe(0);
  });

  it("un operador no suscribe ni da de baja a otro", async () => {
    const { service, repository } = harness();
    const modo = await service.create(GAMES, clasica());

    await expect(service.subscribe(PARLEY, modo.uuid, "rival")).rejects.toBeInstanceOf(
      GameModeForbiddenError,
    );
    await expect(service.unsubscribe(PARLEY, modo.uuid, "rival")).rejects.toBeInstanceOf(
      GameModeForbiddenError,
    );
    expect((await repository.byUuid(modo.uuid))?.subscribers).toEqual([]);
  });

  // ⚠ EL LEGADO SE OFRECE A TODOS: sumar a uno lo dejaría sólo para ése, así que se rechaza hasta que
  // Betaso Games fije la lista entera.
  it("sobre un legado es 409 y no lo toca; fijar la lista lo vuelve explícito", async () => {
    const { service, repository } = harness();
    const viejo = await legacy(repository);

    await expect(service.subscribe(PARLEY, viejo.uuid, "parley")).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );
    await expect(service.unsubscribe(GAMES, viejo.uuid, "parley")).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );
    expect((await repository.byUuid(viejo.uuid))?.subscribers).toBeNull();

    const fijado = await service.setSubscribers(GAMES, viejo.uuid, ["parley", "rival"]);
    expect(fijado).toMatchObject({ subscribers: ["parley", "rival"], version: 0 });
    const despues = await service.unsubscribe(PARLEY, viejo.uuid, "parley");
    expect(despues.subscribers).toEqual(["rival"]);
  });

  it("sólo Betaso Games fija la lista entera", async () => {
    const { service, repository } = harness();
    const modo = await service.create(GAMES, clasica());

    await expect(service.setSubscribers(PARLEY, modo.uuid, ["parley"])).rejects.toBeInstanceOf(
      GameModeForbiddenError,
    );
    expect((await repository.byUuid(modo.uuid))?.subscribers).toEqual([]);
  });

  it("un modo inactivo no admite suscripciones; uno propio no tiene suscriptores", async () => {
    const { service, repository } = harness();
    const retirado = await service.create(GAMES, clasica());
    await service.softDelete(GAMES, retirado.uuid);
    const propio = await service.create(PARLEY, clasica({ name: "Propio" }));

    await expect(service.subscribe(PARLEY, retirado.uuid, "parley")).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );
    await expect(service.subscribe(PARLEY, propio.uuid, "parley")).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );
    await expect(service.setSubscribers(GAMES, propio.uuid, ["x"])).rejects.toBeInstanceOf(
      GameModeStateConflictError,
    );
    // El propio de OTRO operador no existe para éste.
    await expect(service.subscribe(RIVAL, propio.uuid, "rival")).rejects.toBeInstanceOf(
      GameModeNotFoundError,
    );
    expect((await repository.byUuid(propio.uuid))?.subscribers).toEqual([]);
  });

  // LA BAJA ESCRIBE SÓLO `isActive`: reactivar devuelve el modo a los mismos operadores.
  it("dar de baja un compartido conserva sus suscriptores", async () => {
    const { service } = harness();
    const modo = await service.create(GAMES, clasica());
    await service.subscribe(PARLEY, modo.uuid, "parley");

    expect((await service.softDelete(GAMES, modo.uuid)).subscribers).toEqual(["parley"]);
    expect((await service.reactivate(GAMES, modo.uuid)).subscribers).toEqual(["parley"]);
  });

  it("las suscripciones y la copia van adentro del lease", async () => {
    const { service, repository } = harness({ lease: deniedLease });
    const modo = await repository.create(clasica());

    await expect(service.subscribe(PARLEY, modo.uuid, "parley")).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.setSubscribers(GAMES, modo.uuid, [])).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
    await expect(service.copyShared(PARLEY, "parley")).rejects.toBeInstanceOf(
      GameModeWriteBusyError,
    );
  });
});

describe("GameModeService: la copia de los compartidos", () => {
  const ORIGEN = "11111111-2222-4333-8444-555555555555";

  async function seeded() {
    const h = harness();
    // El uuid de origen se fija para poder escribir el de la copia como literal (`copy-uuid.test.ts`).
    const viejo = (await h.repository.insertIfAbsent(ORIGEN, clasica({ name: "Legado" }))).mode;
    makeLegacy(h.repository, ORIGEN);
    const suscrito = await h.repository.create(
      clasica({
        name: "Suscrito",
        playersQuantity: 4,
        betLevels: [{ level: 2, extra: 1, additionalPoints: 5 }],
      }),
    );
    await h.repository.addSubscriber(suscrito.uuid, "parley");
    const ajeno = await h.repository.create(clasica({ name: "Ajeno" }));
    const retirado = await h.repository.create(clasica({ name: "Retirado" }));
    await h.repository.addSubscriber(retirado.uuid, "parley");
    await h.repository.update(retirado.uuid, { isActive: false });
    return { ...h, viejo, suscrito, ajeno, retirado };
  }

  it("copia los activos que juega —legados incluidos— con un uuid determinista", async () => {
    const { service, repository, clock, suscrito } = await seeded();

    const result = await service.copyShared(PARLEY, "parley");

    expect(result.skipped).toEqual([]);
    expect(result.existing).toEqual([]);
    expect(result.created).toContainEqual({
      sourceUuid: ORIGEN,
      uuid: "bb041643-c230-559e-9082-526e5f05487b",
    });
    expect(result.created.map((copy) => copy.sourceUuid).sort()).toEqual(
      [ORIGEN, suscrito.uuid].sort(),
    );
    const copia = await repository.byUuid(
      result.created.find((copy) => copy.sourceUuid === suscrito.uuid)?.uuid ?? "",
    );
    expect(copia).toMatchObject({
      name: "Suscrito",
      playersQuantity: 4,
      prize: suscrito.prize,
      entryFee: suscrito.entryFee,
      betLevels: suscrito.betLevels,
      ownerProviderId: "parley",
      subscribers: [],
      isActive: true,
    });
    // Ni el ajeno (sin suscripción) ni el retirado se copian, y las copias no salen a Betaso.
    expect(await ownedBy(repository, "parley")).toHaveLength(2);
  });

  it("repetirla no duplica ni pisa lo que el operador editó", async () => {
    const { service, repository } = await seeded();
    const primera = await service.copyShared(PARLEY, "parley");
    const copia = primera.created[0] as { uuid: string };
    await service.update(PARLEY, copia.uuid, { prize: 999 });

    const segunda = await service.copyShared(GAMES, "parley");

    const byUuid = (a: { uuid: string }, b: { uuid: string }) => a.uuid.localeCompare(b.uuid);
    expect(segunda.created).toEqual([]);
    expect([...segunda.existing].sort(byUuid)).toEqual([...primera.created].sort(byUuid));
    expect((await repository.byUuid(copia.uuid))?.prize).toBe(999);
    expect(await ownedBy(repository, "parley")).toHaveLength(2);
  });

  // UN REINTENTO DESPUÉS DE UNA COPIA A MEDIAS completa lo que faltó: la base se cae después de la
  // primera copia, y la segunda corrida crea la otra y reconoce la primera.
  it("reintentar después de una copia a medias completa lo que faltó", async () => {
    const { service, repository } = await seeded();
    const real = repository.insertIfAbsent.bind(repository);
    let calls = 0;
    repository.insertIfAbsent = async (uuid, input) => {
      calls += 1;
      if (calls === 2) throw new Error("mongo caído");
      return real(uuid, input);
    };

    await expect(service.copyShared(PARLEY, "parley")).rejects.toThrow("mongo caído");
    expect(await ownedBy(repository, "parley")).toHaveLength(1);

    const retry = await service.copyShared(PARLEY, "parley");

    expect(retry.existing).toHaveLength(1);
    expect(retry.created).toHaveLength(1);
    expect(await ownedBy(repository, "parley")).toHaveLength(2);
  });

  it("un propio del mismo nombre y cantidad con otro uuid se saltea y se informa", async () => {
    const { service, suscrito } = await seeded();
    const mio = await service.create(PARLEY, clasica({ name: "Suscrito", playersQuantity: 4 }));

    const result = await service.copyShared(PARLEY, "parley");

    expect(result.skipped).toEqual([
      {
        sourceUuid: suscrito.uuid,
        name: "Suscrito",
        playersQuantity: 4,
        reason: "NAME_TAKEN",
        conflictUuid: mio.uuid,
      },
    ]);
    expect(result.created.map((copy) => copy.sourceUuid)).toEqual([ORIGEN]);
  });

  it("un origen sin forma de UUID se saltea", async () => {
    const { service, repository } = harness();
    await repository.insertIfAbsent("modo-v1", clasica({ name: "Raro" }));
    makeLegacy(repository, "modo-v1");

    expect(await service.copyShared(PARLEY, "parley")).toEqual({
      created: [],
      existing: [],
      skipped: [
        { sourceUuid: "modo-v1", name: "Raro", playersQuantity: 2, reason: "INVALID_SOURCE_UUID" },
      ],
    });
  });

  it("un operador no copia para otro", async () => {
    const { service, repository } = await seeded();
    const antes = await repository.all();

    await expect(service.copyShared(PARLEY, "rival")).rejects.toBeInstanceOf(
      GameModeForbiddenError,
    );
    expect(await repository.all()).toEqual(antes);
  });
});
