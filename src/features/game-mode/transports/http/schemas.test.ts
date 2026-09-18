import { describe, expect, it } from "vitest";
import type { GameMode } from "../../core/game-mode";
import { CREATE_BODY, UPDATE_BODY, UUID_PARAMS, createInputOf, toDTO } from "./schemas";

// EL FIXTURE LLEVA `id` Y `uuid` DISTINTOS a propósito, igual que el de `events.test.ts`: el `toDTO`
// mapea `id → _id` y el modo tiene los dos identificadores, así que con el mismo valor en los dos
// ninguna aserción distingue cuál se mapeó — y publicar el `uuid` como `_id` le cambia la identidad
// de almacenamiento al panel sin que nada falle.
function mode(over: Partial<GameMode> = {}): GameMode {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    uuid: "11111111-2222-4333-8444-555555555555",
    name: "Clásica",
    multiplier: 1,
    prize: 18,
    entryFee: 10,
    playersQuantity: 2,
    pointsToWin: 25,
    isActive: true,
    isFreeRoom: false,
    enableBots: false,
    createdAt: new Date("2026-09-15T10:00:00.000Z"),
    updatedAt: new Date("2026-09-15T11:00:00.000Z"),
    version: 7,
    ...over,
  };
}

describe("toDTO", () => {
  // `toEqual` CONTRA EL OBJETO ENTERO y no `objectContaining`: lo que este test tiene que atrapar es
  // un campo de MÁS —`id`, `version`, o cualquier nombre interno que se filtre—, y un
  // `objectContaining` es ciego justamente a eso.
  it("devuelve los catorce campos de v1, con `_id` y `__v` y ningún nombre interno", () => {
    expect(toDTO(mode())).toEqual({
      _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      uuid: "11111111-2222-4333-8444-555555555555",
      name: "Clásica",
      multiplier: 1,
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
      pointsToWin: 25,
      isActive: true,
      isFreeRoom: false,
      enableBots: false,
      createdAt: new Date("2026-09-15T10:00:00.000Z"),
      updatedAt: new Date("2026-09-15T11:00:00.000Z"),
      __v: 7,
    });
  });

  // La lista de claves además del `toEqual`, porque el `toEqual` de vitest IGNORA las claves cuyo
  // valor es `undefined`: un `id: undefined` filtrado pasaría verde arriba y saldría igual en el JSON
  // como clave ausente — pero un `version: 0` no, y este test dice cuál es la lista cerrada.
  it("no expone los nombres del core", () => {
    expect(Object.keys(toDTO(mode()))).not.toContain("id");
    expect(Object.keys(toDTO(mode()))).not.toContain("version");
  });
});

describe("CREATE_BODY", () => {
  const minimal = { name: "Clásica", prize: 18, entryFee: 10, playersQuantity: 2 };

  it("completa los defaults del schema productivo de v1", () => {
    expect(CREATE_BODY.parse(minimal)).toEqual({
      name: "Clásica",
      multiplier: 1,
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
      pointsToWin: 25,
      isActive: true,
      isFreeRoom: false,
    });
  });

  // Mongoose coercionaba el string y el DTO histórico declaraba `z.enum(["2","4"])`, así que el panel
  // productivo puede estar mandando cualquiera de las dos formas.
  it.each([
    [2, 2],
    ["2", 2],
    [4, 4],
    ["4", 4],
  ])("acepta playersQuantity %p y lo normaliza a %p", (input, expected) => {
    expect(CREATE_BODY.parse({ ...minimal, playersQuantity: input }).playersQuantity).toBe(
      expected,
    );
  });

  it.each([3, "3", 0, "dos", null])("rechaza playersQuantity %p", (input) => {
    expect(CREATE_BODY.safeParse({ ...minimal, playersQuantity: input }).success).toBe(false);
  });

  // LOS MONTOS SON UC COMPLETAS Y PUEDEN SER FRACCIONARIOS (Tarea 1): `1.5` es un UC y medio. Es la
  // mitad del argumento por el que el techo se escribe `.max(Number.MAX_SAFE_INTEGER)` y no `.safe()`
  // —que en zod 4 implica entero y volvería a rechazar esto—.
  it("acepta montos decimales", () => {
    expect(CREATE_BODY.parse({ ...minimal, prize: 1.5, entryFee: 0.25 })).toMatchObject({
      prize: 1.5,
      entryFee: 0.25,
    });
  });

  // ⚠ EL TECHO DE MAGNITUD, que el snippet del plan se olvidó. Sin `.max(Number.MAX_SAFE_INTEGER)`,
  // `2 ** 53` es una inscripción válida — y a partir de ahí dos importes DISTINTOS son el mismo
  // número, o sea dos precios que el panel cree haber configurado distinto y se cobran igual. Es el
  // mismo agujero que la Tarea 1 cerró en `configOf`.
  it.each([
    ["prize", 2 ** 53],
    ["entryFee", 2 ** 53],
    ["prize", Number.MAX_VALUE],
    ["entryFee", Number.POSITIVE_INFINITY],
    ["prize", Number.NaN],
    ["entryFee", -1],
  ])("rechaza %s = %p", (field, value) => {
    expect(CREATE_BODY.safeParse({ ...minimal, [field]: value }).success).toBe(false);
  });

  it.each([
    { name: "" },
    { multiplier: 0.5 },
    { pointsToWin: 101 },
    { isFreeRoom: "sí" },
    { enableBots: "sí" },
  ])("rechaza el cuerpo con %o", (over) => {
    expect(CREATE_BODY.safeParse({ ...minimal, ...over }).success).toBe(false);
  });

  it.each(["name", "prize", "entryFee", "playersQuantity"])("exige %s", (field) => {
    const body: Record<string, unknown> = { ...minimal };
    delete body[field];
    expect(CREATE_BODY.safeParse(body).success).toBe(false);
  });

  // `strictObject`: lo que el catálogo no conoce no entra. Un `createdBy` que el panel mande de más
  // se contesta 400 en vez de guardarse a medias, que es lo que Mongoose hacía en silencio.
  it("rechaza campos desconocidos", () => {
    expect(CREATE_BODY.safeParse({ ...minimal, createdBy: "admin" }).success).toBe(false);
  });

  // EL BUG DE v1 QUE NO SE PORTA: sus rutas desestructuran ocho campos y `enableBots` no está entre
  // ellos (`Betaso-Domino-Backend/src/game-modes/routes.ts:92-93`), así que el panel podía mandarlo y
  // el servicio nunca lo veía.
  it("deja viajar enableBots hasta la entrada del servicio", () => {
    const parsed = CREATE_BODY.parse({ ...minimal, enableBots: true });

    expect(parsed.enableBots).toBe(true);
    expect(createInputOf(parsed).enableBots).toBe(true);
  });
});

describe("createInputOf", () => {
  // v1 acepta `isActive` en el cuerpo y lo PISA con `true` al crear: el spread del cuerpo va antes
  // (`game-mode.service.ts:64-69`). Un modo nace activo; darlo de baja es otra operación.
  it("ignora el isActive histórico y no lo reenvía al servicio", () => {
    const input = createInputOf(
      CREATE_BODY.parse({
        name: "Clásica",
        prize: 18,
        entryFee: 10,
        playersQuantity: 2,
        isActive: false,
      }),
    );

    expect(Object.keys(input)).not.toContain("isActive");
    expect(input).toEqual({
      name: "Clásica",
      multiplier: 1,
      prize: 18,
      entryFee: 10,
      playersQuantity: 2,
      pointsToWin: 25,
      isFreeRoom: false,
    });
  });
});

describe("UPDATE_BODY", () => {
  // ⚠ EL DEFECTO MÁS CARO DE ESTA TAREA, y el plan lo pedía escrito de la forma que lo produce:
  // «`.partial()` sobre los mismos campos». MEDIDO sobre la zod 4.6 instalada, `.partial()` NO
  // desactiva los defaults —`z.strictObject({ multiplier: z.number().default(1) }).partial()
  // .parse({})` devuelve `{ multiplier: 1 }`—, así que un `PUT` que sólo cambia el premio le
  // reescribiría al modo el multiplicador, los puntos y la sala gratis con los valores de fábrica.
  // Es una edición destructiva silenciosa sobre un modo con dinero configurado.
  it("no aplica ningún default a los campos omitidos", () => {
    expect(UPDATE_BODY.parse({ prize: 20 })).toEqual({ prize: 20 });
    expect(Object.keys(UPDATE_BODY.parse({ prize: 20 }))).toEqual(["prize"]);
    expect(Object.keys(UPDATE_BODY.parse({}))).toEqual([]);
  });

  // La baja y la reactivación son ediciones de este booleano, y v1 lo deja editar por `PUT`
  // (`routes.ts:117-118` lo desestructura y lo reenvía).
  it("acepta isActive", () => {
    expect(UPDATE_BODY.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it("normaliza playersQuantity como el create", () => {
    expect(UPDATE_BODY.parse({ playersQuantity: "4" })).toEqual({ playersQuantity: 4 });
  });

  it("conserva el techo de los montos y rechaza lo desconocido", () => {
    expect(UPDATE_BODY.safeParse({ prize: 2 ** 53 }).success).toBe(false);
    expect(UPDATE_BODY.safeParse({ entryFee: -1 }).success).toBe(false);
    expect(UPDATE_BODY.safeParse({ createdBy: "admin" }).success).toBe(false);
  });

  it("deja viajar enableBots", () => {
    expect(UPDATE_BODY.parse({ enableBots: true })).toEqual({ enableBots: true });
  });
});

describe("UUID_PARAMS", () => {
  // NO SE EXIGE FORMA DE UUID, y no es descuido: el DTO muerto de v1 declaraba `z.string().uuid()`
  // pero nunca corría, así que ninguna ruta productiva lo impuso. Rechazar lo que no tiene forma de
  // UUID convertiría en 400 el pedido por un identificador legítimo que el panel tenga cacheado, y
  // rechazar lo bueno es peor que no validar. Lo que sí se corta son los controles: este valor entra
  // del cliente y termina en el log del operador.
  it("acepta cualquier identificador razonable", () => {
    expect(UUID_PARAMS.parse({ uuid: "mode-1" })).toEqual({ uuid: "mode-1" });
    expect(UUID_PARAMS.safeParse({ uuid: "11111111-2222-4333-8444-555555555555" }).success).toBe(
      true,
    );
  });

  it("rechaza el vacío y los caracteres de control", () => {
    expect(UUID_PARAMS.safeParse({ uuid: "" }).success).toBe(false);
    expect(UUID_PARAMS.safeParse({ uuid: "mode\n1" }).success).toBe(false);
    expect(UUID_PARAMS.safeParse({ uuid: "x".repeat(129) }).success).toBe(false);
  });
});
