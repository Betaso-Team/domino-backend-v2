import { describe, expect, it } from "vitest";
import type { GameModeRepository } from "../../core/catalog.js";
import type { CreateGameMode } from "../../core/game-mode.js";

// EL CONTRATO, ESCRITO UNA SOLA VEZ Y CORRIDO CONTRA LOS DOS ADAPTADORES. `MemoryGameModeRepository`
// no es un doble de test: es el adaptador de la instancia que corre sin Mongo, así que un modo que
// nace con otros defaults o una lista que sale en otro orden es una diferencia de COMPORTAMIENTO
// entre dos despliegues del mismo servidor. Dos suites paralelas describiendo "lo mismo" derivan en
// cuanto una tarea toque un default y se acuerde de un solo archivo; ésta no puede derivar porque es
// el mismo archivo.
//
// Lo que NO vive acá es lo que sólo uno de los dos puede tener: la forma exacta del documento BSON,
// los cuatro índices y el nombre de la colección son del adaptador Mongo y se miden en su propio
// archivo. El contrato mide el PUERTO.

// Un instante fijo y redondo para que las fechas esperadas se puedan escribir a mano. No es
// `Date.now()`: un test que depende del reloj de la máquina mide la máquina.
export const BASE_INSTANT = 1_700_000_000_000;

// El reloj INYECTADO, y mutable a propósito: la mitad de lo que este contrato mide es qué pasa
// cuando el tiempo NO avanza —dos ediciones dentro del mismo milisegundo—, y eso con `Date.now()`
// no se puede escribir.
export interface MutableClock {
  now(): number;
  set(at: number): void;
}

export function mutableClock(at: number = BASE_INSTANT): MutableClock {
  let current = at;
  return {
    now: () => current,
    set: (next) => {
      current = next;
    },
  };
}

export interface RepositoryHarness {
  readonly repository: GameModeRepository;
  readonly clock: MutableClock;
}

// El modo de referencia es el del plan: `Clásica`, 2 jugadores, 18 de premio y 10 de inscripción.
// Deja fuera los cuatro defaulteables justamente para que el adaptador tenga que completarlos.
export function clasica(over: Partial<CreateGameMode> = {}): CreateGameMode {
  return { name: "Clásica", prize: 18, entryFee: 10, playersQuantity: 2, ...over };
}

export function describeGameModeRepositoryContract(
  label: string,
  harnessOf: () => RepositoryHarness,
): void {
  describe(`${label}: creación y defaults`, () => {
    it("completa los cuatro defaulteables, nace activo y con revisión cero", async () => {
      const { repository } = harnessOf();

      const created = await repository.create(clasica());

      expect(created).toEqual({
        id: expect.any(String),
        uuid: expect.any(String),
        name: "Clásica",
        multiplier: 1,
        prize: 18,
        entryFee: 10,
        playersQuantity: 2,
        // El default REAL es el del schema Mongoose de v1 (25), no el `10` del DTO zod: ese DTO
        // nunca se ejecutaba —`routes.ts` desestructura `req.body` crudo— y su default era código
        // muerto. Ver `Betaso-Domino-Backend/src/storage/mongo/schemas/game-mode.schema.ts:51-56`.
        pointsToWin: 25,
        isActive: true,
        isFreeRoom: false,
        enableBots: false,
        createdAt: new Date(BASE_INSTANT),
        updatedAt: new Date(BASE_INSTANT),
        version: 0,
      });
    });

    // EL DEFAULT QUE DEPENDE DE OTRO CAMPO, y el único del documento que no es una constante:
    // v1 lo declara como función del propio documento
    // (`game-mode.schema.ts:66-71`, `default() { return this.playersQuantity === 4 }`).
    // Perderlo deja todo modo de cuatro con los bots apagados sin que nadie escriba un valor.
    it("una mesa de cuatro nace con los bots habilitados", async () => {
      const { repository } = harnessOf();

      const created = await repository.create(clasica({ name: "Cuarteto", playersQuantity: 4 }));

      expect(created.playersQuantity).toBe(4);
      expect(created.enableBots).toBe(true);
    });

    // El default es DEFAULT y no una regla: un `false` explícito sobre una mesa de cuatro se
    // respeta. Es la diferencia entre `??` y `||`, que con un booleano falso no se ve de otra
    // forma.
    it("un enableBots explícito le gana al default de cuatro jugadores", async () => {
      const { repository } = harnessOf();

      const created = await repository.create(
        clasica({ name: "Cuarteto sin bots", playersQuantity: 4, enableBots: false }),
      );

      expect(created.enableBots).toBe(false);
    });

    it("respeta los cuatro defaulteables cuando vienen dados", async () => {
      const { repository } = harnessOf();

      const created = await repository.create(
        clasica({ multiplier: 2, pointsToWin: 100, isFreeRoom: true, enableBots: false }),
      );

      expect(created).toMatchObject({
        multiplier: 2,
        pointsToWin: 100,
        isFreeRoom: true,
        enableBots: false,
      });
    });

    // LOS IMPORTES SON UC COMPLETAS Y NO SE ESCALAN. Es la corrección de la Tarea 1 de este mismo
    // incremento llevada hasta la base: un `* 100` en una sola de las dos puntas cobra cien veces
    // la inscripción, y el catálogo productivo de v1 tiene modos con decimales.
    it("los importes decimales se guardan tal cual, sin escalar", async () => {
      const { repository } = harnessOf();

      const created = await repository.create(
        clasica({ name: "Media UC", entryFee: 1.5, prize: 2.75, multiplier: 1.5 }),
      );

      expect(created).toMatchObject({ entryFee: 1.5, prize: 2.75, multiplier: 1.5 });
    });

    it("cada modo nace con su propio uuid", async () => {
      const { repository } = harnessOf();

      const uno = await repository.create(clasica());
      const otro = await repository.create(clasica({ name: "Otra" }));

      expect(uno.uuid).not.toBe(otro.uuid);
      expect(uno.id).not.toBe(otro.id);
    });

    // EL ROUND-TRIP: lo que el mapper devuelve al crear tiene que ser lo mismo que devuelve al
    // releer. Un campo que el mapper de escritura escribe y el de lectura no lee —o al revés— sólo
    // se ve cruzando las dos direcciones.
    it("lo que devuelve crear es lo que devuelve releer", async () => {
      const { repository } = harnessOf();

      const created = await repository.create(clasica({ playersQuantity: 4, isFreeRoom: true }));

      expect(await repository.byUuid(created.uuid)).toEqual(created);
    });
  });

  describe(`${label}: listados`, () => {
    // El orden es RECIENTES PRIMERO, igual que el `sort({ createdAt: -1 })` de v1
    // (`game-mode.service.ts:25` y `:36`). Es una propiedad de la consulta y por eso la fija el
    // adaptador, pero los dos adaptadores tienen que fijar la misma: el lobby de una instancia sin
    // Mongo mostraría el catálogo al revés.
    it("active() devuelve sólo los activos, recientes primero", async () => {
      const { repository, clock } = harnessOf();
      const viejo = await repository.create(clasica({ name: "Vieja" }));
      clock.set(BASE_INSTANT + 1_000);
      const medio = await repository.create(clasica({ name: "Media" }));
      clock.set(BASE_INSTANT + 2_000);
      const nuevo = await repository.create(clasica({ name: "Nueva" }));
      clock.set(BASE_INSTANT + 3_000);
      await repository.update(medio.uuid, { isActive: false });

      expect((await repository.active()).map((mode) => mode.name)).toEqual(["Nueva", "Vieja"]);
      expect(nuevo.createdAt.getTime()).toBeGreaterThan(viejo.createdAt.getTime());
    });

    // `all()` es lo que ve el PANEL, y por eso incluye los dados de baja: reactivarlos exige poder
    // listarlos primero.
    it("all() incluye los inactivos, con el mismo orden", async () => {
      const { repository, clock } = harnessOf();
      await repository.create(clasica({ name: "Vieja" }));
      clock.set(BASE_INSTANT + 1_000);
      const medio = await repository.create(clasica({ name: "Media" }));
      clock.set(BASE_INSTANT + 2_000);
      await repository.create(clasica({ name: "Nueva" }));
      clock.set(BASE_INSTANT + 3_000);
      await repository.update(medio.uuid, { isActive: false });

      expect((await repository.all()).map((mode) => mode.name)).toEqual([
        "Nueva",
        "Media",
        "Vieja",
      ]);
    });

    it("sin modos, los dos listados son vacíos", async () => {
      const { repository } = harnessOf();

      expect(await repository.active()).toEqual([]);
      expect(await repository.all()).toEqual([]);
    });
  });

  describe(`${label}: búsqueda por uuid`, () => {
    // DESDE AFUERA, UN MODO DADO DE BAJA NO EXISTE. Es la diferencia que impide que una mesa nazca
    // con un modo retirado, y es el mismo `findOne({ uuid, isActive: true })` de v1
    // (`game-mode.service.ts:47`).
    it("activeByUuid esconde los inactivos y byUuid los encuentra", async () => {
      const { repository } = harnessOf();
      const created = await repository.create(clasica());

      expect(await repository.activeByUuid(created.uuid)).toEqual(created);

      const baja = await repository.update(created.uuid, { isActive: false });

      expect(await repository.activeByUuid(created.uuid)).toBeUndefined();
      expect(await repository.byUuid(created.uuid)).toEqual(baja);
    });

    it("un uuid que no existe devuelve undefined por las dos puertas", async () => {
      const { repository } = harnessOf();

      expect(await repository.byUuid("no-existe")).toBeUndefined();
      expect(await repository.activeByUuid("no-existe")).toBeUndefined();
    });
  });

  describe(`${label}: edición`, () => {
    // UN CAMPO AUSENTE NO SE TOCA. Es la diferencia entre un `PUT` parcial y un borrado silencioso
    // de todo lo que el panel no mandó — y el panel de v1 manda formularios incompletos.
    it("los campos omitidos quedan como estaban", async () => {
      const { repository } = harnessOf();
      const created = await repository.create(
        clasica({ multiplier: 3, pointsToWin: 50, isFreeRoom: true }),
      );

      const updated = await repository.update(created.uuid, { name: "Renombrada" });

      expect(updated).toEqual({
        ...created,
        name: "Renombrada",
        updatedAt: new Date(BASE_INSTANT),
        version: 1,
      });
    });

    // EL CAMPO MANDADO COMO `undefined`, que no es lo mismo que el campo ausente y es el caso que
    // de verdad va a llegar: las rutas de v1 desestructuran el cuerpo entero y pasan TODAS las
    // claves, así que un `PUT` que sólo trae el premio llega como
    // `{ name: undefined, multiplier: undefined, prize: 20, ... }` y la frontera HTTP de la Tarea 9
    // hereda esa forma. Un spread crudo lo escribiría encima: del lado de Mongo queda un `null` en
    // la base, y del lado de memoria un `undefined` que el DTO serializa como campo perdido. La
    // primera versión de este contrato no lo medía y las dos implementaciones ingenuas pasaban.
    it("un campo mandado como undefined tampoco borra nada", async () => {
      const { repository } = harnessOf();
      const created = await repository.create(clasica({ multiplier: 3, isFreeRoom: true }));

      const updated = await repository.update(created.uuid, {
        name: undefined,
        multiplier: undefined,
        prize: 20,
        entryFee: undefined,
        playersQuantity: undefined,
        pointsToWin: undefined,
        isActive: undefined,
        isFreeRoom: undefined,
        enableBots: undefined,
      });

      expect(updated).toEqual({ ...created, prize: 20, version: 1 });
    });

    it("edita todos los campos editables de una", async () => {
      const { repository } = harnessOf();
      const created = await repository.create(clasica());

      const updated = await repository.update(created.uuid, {
        name: "Otra",
        multiplier: 2,
        prize: 36,
        entryFee: 20,
        playersQuantity: 4,
        pointsToWin: 75,
        isActive: false,
        isFreeRoom: true,
        enableBots: true,
      });

      expect(updated).toMatchObject({
        name: "Otra",
        multiplier: 2,
        prize: 36,
        entryFee: 20,
        playersQuantity: 4,
        pointsToWin: 75,
        isActive: false,
        isFreeRoom: true,
        enableBots: true,
      });
      // La identidad y el nacimiento NO son editables: un `update` que los moviera convertiría
      // una edición en un modo distinto, y el panel seguiría viendo el uuid de antes.
      expect(updated?.id).toBe(created.id);
      expect(updated?.uuid).toBe(created.uuid);
      expect(updated?.createdAt).toEqual(created.createdAt);
    });

    it("editar la fecha de modificación usa el reloj inyectado", async () => {
      const { repository, clock } = harnessOf();
      const created = await repository.create(clasica());
      clock.set(BASE_INSTANT + 5_000);

      const updated = await repository.update(created.uuid, { prize: 20 });

      expect(updated?.updatedAt).toEqual(new Date(BASE_INSTANT + 5_000));
      expect(updated?.createdAt).toEqual(new Date(BASE_INSTANT));
    });

    // EL RELOJ NO ES LA REVISIÓN, y éste es el test que lo cobra. La implementación obvia y
    // equivocada es derivar `version` de `updatedAt`: dos ediciones del mismo milisegundo
    // colapsarían en la misma revisión, y entonces la revisión deja de distinguir cambios.
    it("dos ediciones del mismo milisegundo avanzan la revisión igual", async () => {
      const { repository } = harnessOf();
      const created = await repository.create(clasica());

      const primera = await repository.update(created.uuid, { prize: 19 });
      const segunda = await repository.update(created.uuid, { prize: 20 });

      expect(created.version).toBe(0);
      expect(primera?.version).toBe(1);
      expect(segunda?.version).toBe(2);
      expect(primera?.updatedAt).toEqual(segunda?.updatedAt);
    });

    // `undefined` y no un throw: "no existe" es una respuesta esperable de un `PUT` sobre un uuid
    // que el panel tiene cacheado, y la frontera HTTP la convierte en 404.
    it("editar un uuid inexistente devuelve undefined y no crea nada", async () => {
      const { repository } = harnessOf();

      expect(await repository.update("no-existe", { name: "Fantasma" })).toBeUndefined();
      expect(await repository.all()).toEqual([]);
    });
  });
}
