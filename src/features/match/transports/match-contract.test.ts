import { describe, expect, it } from "vitest";
import { configOf, replayConfigOf, requestOf } from "./match-contract";

// LAS DOS FRONTERAS, y desde esta tarea son dos porque las entradas son dos cosas distintas.
//
// `requestOf` valida lo que el orquestador PIDE: una mesa, unos participantes y su modo en línea
// (`gameMode`). El dinero y los puntos viajan solo dentro del modo, y `configOf` los copia de ahí.
//
// `replayConfigOf` valida el snapshot YA GRABADO: la misma mesa, con sus asientos numerados y su
// dinero adentro. No consulta nada. Son dos funciones y no una con un parámetro opcional porque
// miden cosas distintas: una decide si una mesa puede NACER, la otra si un snapshot guardado se
// puede REBOBINAR, y el día que los modos cambien de reglas la segunda no puede cambiar con él.
const participants = [
  {
    userId: "ada",
    displayName: "Ada",
    username: "ada",
    profilePicture: "https://img.test/ada.png",
    currency: "VES",
  },
  {
    userId: "lin",
    displayName: "Lin",
    currency: "USD",
  },
] as const;

// EL MODO, escrito a mano. Los importes son UC completas (`entryFee: 125` son 125 UC) y difieren de
// todo lo demás del pedido, que es lo que hace visible de dónde salió cada número.
const gameMode = {
  name: "clasica-2p",
  playersQuantity: 2,
  pointsToWin: 100,
  multiplier: 1,
  entryFee: 125,
  prize: 250,
  isFreeRoom: false,
  enableBots: false,
} as const;

const request = {
  mode: "CASUAL",
  matchId: "match-1",
  gameModeId: "mode-2p",
  gameMode,
  participants,
  seed: "seed-1",
  teamAssignment: "SHUFFLED",
  rateId: "00000000-0000-4000-8000-000000000001",
} as const;

/** El pedido con otro modo en línea. */
const withMode = (overrides: Record<string, unknown>, input: object = request) => ({
  ...input,
  gameMode: { ...gameMode, ...overrides },
});

const configFrom = (input: unknown = request) => configOf(requestOf(input));

// OTRO PRINCIPAL CUALQUIERA, para armar mesas de largo distinto del válido. Cada uno es un
// `userId` nuevo, así que lo único que estas filas ejercen es el LARGO — si reusaran uno
// existente, el rechazo podría venir del control de duplicados y la fila mediría otra regla.
const extra = (n: number) => ({
  userId: `extra-${n}`,
  displayName: `Extra ${n}`,
  currency: "VES",
});

describe("requestOf", () => {
  // EL DINERO Y LOS PUNTOS SUELTOS NO ENTRAN, y este es el test que lo pinea. El `strictObject`
  // los rechaza en vez de ignorarlos: van dentro de `gameMode`, y aceptarlos sueltos en silencio
  // dejaría al llamador creyendo que fijó algo que el modo pisa.
  it.each<[string, Record<string, unknown>]>([
    ["pointsToWin", { pointsToWin: 7 }],
    ["entryFee", { entryFee: 1 }],
    ["prize", { prize: 2 }],
  ])("rechaza que el request traiga %s fuera del modo", (_name, override) => {
    expect(() => requestOf({ ...request, ...override })).toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["rateId vacío", { rateId: " " }],
    ["gameModeId vacío", { gameModeId: " " }],
    ["sin gameModeId", { gameModeId: undefined }],
    // SIN SU MODO NO HAY MESA: dominó no tiene catálogo de donde sacarlo.
    ["sin gameMode", { gameMode: undefined }],
    // LAS TRES DEL LARGO DE LA MESA. Sin ellas, borrar el `superRefine` de paridad deja la
    // suite entera en verde y una mesa de 3 revienta recién adentro de `assignTeams` — o sea
    // después de crear la sala, que es después del cobro.
    ["cantidad impar", { participants: [...participants, extra(1)] }],
    ["un solo participante", { participants: [participants[0]] }],
    ["cinco participantes", { participants: [...participants, extra(1), extra(2), extra(3)] }],
    ["currency vacía", { participants: [{ ...participants[0], currency: " " }, participants[1]] }],
    [
      "userId ausente",
      { participants: [{ ...participants[0], userId: undefined }, participants[1]] },
    ],
    [
      "displayName ausente",
      { participants: [{ ...participants[0], displayName: undefined }, participants[1]] },
    ],
  ])("rechaza %s", (_name, override) => {
    expect(() => requestOf({ ...request, ...override })).toThrow();
  });

  // EL `userId` ES LO ÚNICO ÚNICO de la mesa: repetirlo es el mismo principal sentado dos
  // veces, cobrando dos inscripciones y pudiendo jugar contra sí mismo. Fue la PAREJA
  // `{ platformId, userId }` mientras el Betaso podía tener dos productos sobre el mismo
  // espacio de UUIDs; con la identidad aplanada esa distinción dejó de existir.
  it("acepta dos userId distintos y rechaza el mismo dos veces", () => {
    expect(() => requestOf(request)).not.toThrow();
    expect(() =>
      requestOf({ ...request, participants: [participants[0], participants[0]] }),
    ).toThrow(/duplicada/);
  });

  // Y NORMALIZAR ANTES DE COMPARAR es lo que impide colar al mismo jugador dos veces con un
  // espacio de más. `superRefine` recibe la salida del objeto, así que ve los valores ya
  // recortados; si corriera sobre la entrada, esta mesa pasaría y cobraría dos asientos al
  // mismo principal.
  it("el padding no alcanza para duplicar un jugador", () => {
    expect(() =>
      requestOf({
        ...request,
        participants: [participants[0], { ...participants[0], userId: " ada " }],
      }),
    ).toThrow(/duplicada/);
  });
});

// EL PRECIO EN LA MONEDA DEL JUGADOR, opcional: lo manda el orquestador con la cotización de billing y
// el dominó sólo lo muestra y lo elige. Lo que esta frontera cierra es la FORMA —texto decimal, la moneda
// del asiento, un nivel una vez— porque de acá para adentro nadie lo vuelve a mirar.
describe("requestOf: el precio de cada asiento", () => {
  const price = {
    currency: "VES",
    rate: "200",
    entry: "200.00",
    prize: "300.00",
    levels: [{ level: 2, entry: "200.00", prize: "600.00" }],
  };
  const withPrice = (overrides: Record<string, unknown> = {}) => ({
    ...request,
    participants: [{ ...participants[0], price: { ...price, ...overrides } }, participants[1]],
  });

  it("lo acepta y lo deja en el asiento tal cual; el que no lo trae sigue sin él", () => {
    const config = configFrom(withPrice());
    expect(config.seats[0]?.price).toEqual(price);
    expect(config.seats[1]).not.toHaveProperty("price");
  });

  it("sin niveles es una mesa que no cotizó aumentos", () => {
    const { levels, ...bare } = price;
    const input = {
      ...request,
      participants: [{ ...participants[0], price: bare }, participants[1]],
    };
    expect(requestOf(input).participants[0]?.price?.levels).toEqual([]);
  });

  it("acepta los decimales de la moneda (aditivo) y los deja en el precio", () => {
    expect(configFrom(withPrice({ decimals: 2 })).seats[0]?.price).toEqual({
      ...price,
      decimals: 2,
    });
    expect(configFrom(withPrice({ decimals: 0 })).seats[0]?.price?.decimals).toBe(0);
    expect(configFrom(withPrice()).seats[0]?.price).not.toHaveProperty("decimals");
  });

  it("sin precio en nadie el pedido es el de siempre", () => {
    expect(requestOf(request).participants.every((seat) => seat.price === undefined)).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["un monto numérico", { entry: 200 }],
    ["un monto negativo", { prize: "-1.00" }],
    ["un monto con coma", { entry: "200,00" }],
    ["un monto con exponente", { entry: "2e2" }],
    ["un monto vacío", { entry: "" }],
    ["un monto larguísimo", { entry: "1".repeat(33) }],
    ["una tasa que no es decimal", { rate: "doscientos" }],
    ["otra moneda que la del asiento", { currency: "USD" }],
    ["el nivel 1", { levels: [{ level: 1, entry: "0", prize: "300.00" }] }],
    ["un nivel no entero", { levels: [{ level: 2.5, entry: "1", prize: "1" }] }],
    [
      "un nivel repetido",
      {
        levels: [
          { level: 2, entry: "1", prize: "1" },
          { level: 2, entry: "2", prize: "2" },
        ],
      },
    ],
    [
      "más de 16 niveles",
      { levels: Array.from({ length: 17 }, (_, i) => ({ level: i + 2, entry: "1", prize: "1" })) },
    ],
    ["una clave de más", { extra: "1" }],
    ["una clave de más junto a los decimales", { decimals: 2, extra: "1" }],
    ["decimales negativos", { decimals: -1 }],
    ["decimales no enteros", { decimals: 2.5 }],
    ["más de 8 decimales", { decimals: 9 }],
    ["decimales como texto", { decimals: "2" }],
    ["un nivel con una clave de más", { levels: [{ level: 2, entry: "1", prize: "1", x: 1 }] }],
  ])("rechaza %s", (_name, overrides) => {
    expect(() => requestOf(withPrice(overrides))).toThrow();
  });
});

describe("configOf", () => {
  it("normaliza identidades externas a ids opacos reproducibles", () => {
    expect(configFrom().seats).toEqual([
      { ...participants[0], playerId: "seat-1" },
      { ...participants[1], playerId: "seat-2" },
    ]);
  });

  // LA MESA GRATIS NO OFRECE AUMENTAR aunque el llamador traiga niveles: no hay entrada que
  // multiplicar ni premio que escalar. Es la regla de v1 (`on-propose-bet-multiplier.ts:46`) y la de
  // truco (`092f42b`).
  it("en mesa gratis no hay niveles de aumento aunque el request los traiga", () => {
    const levels = [{ level: 2, extra: 5, additionalPoints: 10 }];
    expect(configOf(requestOf(request), levels).betLevels).toEqual(levels);
    expect(configOf(requestOf(withMode({ isFreeRoom: true })), levels).betLevels).toEqual([]);
  });

  // Los valores van como LITERAL y no leídos del modo: recalcularlos con el mismo campo que la
  // implementación copia mediría que dos lecturas del mismo dato coinciden.
  it("arma la mesa con el modo del pedido", () => {
    const config = configFrom(
      withMode({ pointsToWin: 75, multiplier: 3, entryFee: 1.5, prize: 2.75, enableBots: true }),
    );

    expect(config).toMatchObject({
      gameModeId: "mode-2p",
      pointsToWin: 75,
      multiplier: 3,
      entryFee: 1.5,
      prize: 2.75,
      isFreeRoom: false,
      enableBots: true,
    });
  });

  it("conserva matchId, seed, teamAssignment y rateId del request", () => {
    const config = configFrom();
    expect(config.matchId).toBe("match-1");
    expect(config.seed).toBe("seed-1");
    expect(config.teamAssignment).toBe("SHUFFLED");
    expect(config.rateId).toBe("00000000-0000-4000-8000-000000000001");
    // La ventana siempre encendida: es control de presencia, no una opción del modo.
    expect(config.isDealWindowEnabled).toBe(true);
  });

  // EL `rateId` ES DEL QUE COBRA, no nuestro. El de Betaso es el `_id` de Mongo de su documento de
  // tasas, no un UUID: exigir una forma que el emisor no promete es rechazar mesas legítimas.
  it("acepta un rateId que no es UUID", () => {
    const config = configFrom({ ...request, rateId: "69977c3dc3bf3e710572f941" });
    expect(config.rateId).toBe("69977c3dc3bf3e710572f941");
  });

  // LA IDENTIDAD SE GUARDA NORMALIZADA. El asiento se compara contra el `sub` del token, así
  // que un `userId` con padding acá y sin padding allá sería el mismo jugador para el
  // validador y dos distintos para `onJoin` — asiento rechazado con la inscripción cobrada.
  it("normaliza los espacios de la identidad y deja la moneda intacta", () => {
    const padded = configFrom({
      ...request,
      participants: [{ ...participants[0], userId: "  ada  ", currency: " VES " }, participants[1]],
    });

    expect(padded.seats[0]).toMatchObject({ userId: "ada" });
    // La moneda es un valor CONTABLE, no una llave: se conserva exactamente como se cobró.
    expect(padded.seats[0]?.currency).toBe(" VES ");
  });

  // LA MESA DE CUATRO NACE, y hasta este incremento no podía: se rechazaba acá porque
  // `payoutOf` exigía exactamente un ganador y el final de una mesa de cuatro lanzaba DESPUÉS
  // del veredicto —sin premio y sin reembolso, o sea plata trabada—. Lo que la abrió fue traer la
  // regla de reparto de v1, no borrar la guarda.
  it("sienta un modo de cuatro y le copia los bots", () => {
    const config = configFrom(
      withMode(
        { playersQuantity: 4, enableBots: true },
        { ...request, participants: [...participants, extra(1), extra(2)] },
      ),
    );

    expect(config.seats.map(({ playerId }) => playerId)).toEqual([
      "seat-1",
      "seat-2",
      "seat-3",
      "seat-4",
    ]);
    expect(config.enableBots).toBe(true);
  });

  // LA CANTIDAD LA DECIDE EL MODO. Sin esta guarda, un request de cuatro contra un modo de dos
  // sienta a cuatro personas en una mesa cuyo premio se calculó para dos: el motor arranca, la
  // partida se juega y la liquidación reparte mal.
  it.each<[string, object]>([
    [
      "cuatro contra un modo de dos",
      { ...request, participants: [...participants, extra(1), extra(2)] },
    ],
    ["dos contra un modo de cuatro", withMode({ playersQuantity: 4 })],
  ])("rechaza %s con SEAT_COUNT_MISMATCH", (_name, input) => {
    expect(() => configFrom(input)).toThrow(/SEAT_COUNT_MISMATCH/);
  });
});

// LAS GUARDAS DEL MODO EN LÍNEA, que son las del snapshot: lo que el orquestador mande mal no llega
// a sentar una mesa.
describe("el modo en línea (`gameMode`)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["sin nombre", { name: "" }],
    ["nombre de más de 100", { name: "x".repeat(101) }],
    ["tres jugadores", { playersQuantity: 3 }],
    ["jugadores como string", { playersQuantity: "2" }],
    ["puntos en cero", { pointsToWin: 0 }],
    ["puntos fraccionarios", { pointsToWin: 1.5 }],
    ["puntos fuera del rango seguro", { pointsToWin: Number.MAX_SAFE_INTEGER + 1 }],
    ["multiplicador en cero", { multiplier: 0 }],
    ["multiplicador fraccionario", { multiplier: 1.5 }],
    ["entrada negativa", { entryFee: -1 }],
    ["premio infinito", { prize: Number.POSITIVE_INFINITY }],
    ["premio fuera del rango seguro", { prize: Number.MAX_SAFE_INTEGER + 1 }],
    ["sin isFreeRoom", { isFreeRoom: undefined }],
    ["sin enableBots", { enableBots: undefined }],
    ["un campo de más", { betLevels: [] }],
    ["el uuid adentro", { uuid: "otro" }],
  ])("rechaza un modo en línea %s", (_name, override) => {
    expect(() => requestOf(withMode(override))).toThrow();
  });

  it("una mesa de torneo no acepta un modo en línea", () => {
    expect(() =>
      requestOf({
        mode: "TOURNAMENT",
        matchId: "t-match",
        tournamentId: "t-1",
        participants,
        seed: "s",
        teamAssignment: "SEAT_ORDER",
        rules: { pointsToWin: 50 },
        gameMode,
      }),
    ).toThrow();
  });
});

// EL SNAPSHOT GRABADO, que es la otra mitad de la tarea: una partida tiene que poder rebobinarse
// sin catálogo. `replayConfigOf` valida la mesa ENTERA —asientos numerados, puntos y dinero
// adentro— y no consulta nada; es lo que permite que editar un modo no cambie una partida vieja.
// EL PROVEEDOR DE CADA ASIENTO (el `prv` de la sesión), para el ámbito del panel. Opcional en las dos
// entradas —casual y torneo— y en el snapshot; una LLAVE como el `userId`: se normaliza igual.
describe("requestOf: el proveedor de cada asiento", () => {
  const { gameModeId: _mode, gameMode: _gameMode, rateId: _rate, ...shared } = request;
  const tournament = {
    ...shared,
    mode: "TOURNAMENT",
    tournamentId: "t-1",
    rules: { pointsToWin: 50 },
  } as const;
  const provided = <T extends object>(base: T, providerId: unknown) => ({
    ...base,
    participants: [{ ...participants[0], providerId }, participants[1]],
  });

  it("lo deja en el asiento, sin espacios, en la casual y en la de torneo", () => {
    for (const base of [request, tournament]) {
      const config = configFrom(provided(base, " betaso "));
      expect(config.seats[0]?.providerId).toBe("betaso");
      expect(config.seats[1]).not.toHaveProperty("providerId");
    }
  });

  it.each<[string, unknown]>([
    ["vacío", ""],
    ["en blanco", "  "],
    ["numérico", 7],
    ["nulo", null],
  ])("rechaza un proveedor %s", (_name, providerId) => {
    expect(() => requestOf(provided(request, providerId))).toThrow();
    expect(() => requestOf(provided(tournament, providerId))).toThrow();
  });
});

describe("replayConfigOf", () => {
  const snapshot = {
    matchId: "match-1",
    gameModeId: "mode-2p",
    seats: [
      { ...participants[0], playerId: "seat-1" },
      { ...participants[1], playerId: "seat-2" },
    ],
    seed: "seed-1",
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: true,
    rateId: "00000000-0000-4000-8000-000000000001",
    entryFee: 125,
    prize: 250,
  };

  // EL SNAPSHOT DE ARRIBA ES UNO VIEJO A PROPÓSITO: no tiene los dos campos del aumento ni el
  // peso del modo en el ranking, porque se grabó antes de que existieran. Que rebobine igual —y
  // que salga con el aumento APAGADO y el peso en su neutro— es la razón entera de que esos tres
  // lleven default en el schema: sin ellos, el día que se agregó cada feature todos los goldens y
  // toda la historia en Mongo dejaban de poder reconstruirse, que es justo lo que el replay existe
  // para poder hacer.
  //
  // Sigue siendo `toEqual` y no `toMatchObject`: lo que se agrega se escribe acá, así que un
  // campo que aparezca de más —o un grabado que se pierda— pone esto en rojo igual.
  it("reconstruye el snapshot completo tal cual se grabó, con el aumento apagado", () => {
    expect(replayConfigOf(snapshot)).toEqual({
      ...snapshot,
      betLevels: [],
      isFreeRoom: false,
      isRematchEnabled: false,
      multiplier: 1,
      enableBots: false,
    });
  });

  // UNA MESA DE CUATRO GRABADA SÍ SE REBOBINA, y la asimetría con `configOf` es deliberada: el
  // rechazo del 4P es sobre mesas que NACEN, no sobre historia que ya existe. Un soporte que no
  // puede rebobinar una partida no la puede auditar, y auditarla es justamente lo que hace falta
  // el día que una mesa de cuatro quede con la plata trabada.
  it("acepta un snapshot de cuatro asientos", () => {
    const fourSeats = {
      ...snapshot,
      seats: [
        { ...participants[0], playerId: "seat-1" },
        { ...participants[1], playerId: "seat-2" },
        { ...extra(1), playerId: "seat-3" },
        { ...extra(2), playerId: "seat-4" },
      ],
    };
    expect(replayConfigOf(fourSeats).seats).toHaveLength(4);
  });

  // LAS CUATRO PUERTAS QUE QUEDAN ABIERTAS cuando la fracción deja de ser un error. `NaN` e
  // `Infinity` son montos que ningún pagador puede acreditar y que sobreviven a cualquier
  // aritmética posterior contaminándola; el negativo es un cobro al revés; y el que se pasa del
  // rango seguro es el que hace que dos montos distintos sean el mismo número. Se miden acá y no
  // en `configOf` porque desde esta tarea el dinero entra por el snapshot, no por el request.
  it.each<[string, Record<string, unknown>]>([
    ["UC no numérica", { entryFee: Number.NaN }],
    ["UC infinita", { prize: Number.POSITIVE_INFINITY }],
    ["UC insegura", { prize: Number.MAX_SAFE_INTEGER + 1 }],
    ["UC negativa", { prize: -1 }],
    ["rateId vacío", { rateId: " " }],
    ["pointsToWin en cero", { pointsToWin: 0 }],
    ["ventana de reparto ausente", { isDealWindowEnabled: undefined }],
    ["asiento sin playerId", { seats: [{ ...participants[0] }, snapshot.seats[1]] }],
    ["cantidad impar", { seats: [snapshot.seats[0]] }],
  ])("rechaza %s", (_name, override) => {
    expect(() => replayConfigOf({ ...snapshot, ...override })).toThrow();
  });

  // UNA PARTIDA GRABADA ANTES DEL PRECIO NO SE INVENTA UNO: sin default, el asiento sale sin `price`.
  // Y una grabada CON precio lo conserva, con las mismas reglas que el pedido.
  it("rebobina sin precio lo que se grabó sin precio, y con precio lo que lo trajo", () => {
    expect(replayConfigOf(snapshot).seats.some((seat) => "price" in seat)).toBe(false);
    const price = { currency: "VES", rate: "200", entry: "200.00", prize: "300.00", levels: [] };
    const priced = { ...snapshot, seats: [{ ...snapshot.seats[0], price }, snapshot.seats[1]] };
    expect(replayConfigOf(priced).seats[0]?.price).toEqual(price);
    const foreign = {
      ...snapshot,
      seats: [{ ...snapshot.seats[0], price: { ...price, currency: "USD" } }, snapshot.seats[1]],
    };
    expect(() => replayConfigOf(foreign)).toThrow();
  });

  // UNA PARTIDA GRABADA ANTES DEL PROVEEDOR SE REBOBINA SIN ÉL, y una que lo trajo lo conserva.
  it("rebobina con y sin el proveedor del asiento", () => {
    expect(replayConfigOf(snapshot).seats.some((seat) => "providerId" in seat)).toBe(false);
    const provided = {
      ...snapshot,
      seats: [{ ...snapshot.seats[0], providerId: "betaso" }, snapshot.seats[1]],
    };
    expect(replayConfigOf(provided).seats[0]?.providerId).toBe("betaso");
  });

  // EL DECIMAL ES UN MONTO VÁLIDO, y este test es el que separa la convención de v1 de la que
  // había acá: un modo productivo con `entryFee: 1.5` son UN UC Y MEDIO, no quince centésimos.
  it("conserva los decimales finitos sin escalarlos", () => {
    const config = replayConfigOf({ ...snapshot, entryFee: 1.5, prize: 2.75 });
    expect(config.entryFee).toBe(1.5);
    expect(config.prize).toBe(2.75);
  });
});

// LA MESA DE TORNEO: gratis, sin catálogo y sin ningún campo de dinero en el pedido.
describe("mesa de torneo", () => {
  const { gameModeId: _mode, gameMode: _gameMode, rateId: _rate, ...shared } = request;
  const tournament = {
    ...shared,
    mode: "TOURNAMENT",
    tournamentId: "t-1",
    rules: { pointsToWin: 50 },
  } as const;

  it("arma el snapshot sin modo: gratis, sin bots, sin aumentos ni revancha", () => {
    // Los niveles que se le pasen no la tocan.
    const levels = [{ level: 2, extra: 5, additionalPoints: 10 }];
    expect(configOf(requestOf(tournament), levels)).toEqual({
      mode: "TOURNAMENT",
      tournamentId: "t-1",
      matchId: "match-1",
      gameModeId: "tournament:t-1",
      seats: [
        { ...participants[0], playerId: "seat-1" },
        { ...participants[1], playerId: "seat-2" },
      ],
      seed: "seed-1",
      pointsToWin: 50,
      teamAssignment: "SHUFFLED",
      isDealWindowEnabled: true,
      rateId: "none",
      entryFee: 0,
      prize: 0,
      multiplier: 1,
      isFreeRoom: true,
      enableBots: false,
      isRematchEnabled: false,
      betLevels: [],
    });
  });

  // EL TOPE ES DE TORNEOS, no del dominó: 150 (más que el techo del catálogo casual del orquestador) es
  // una mesa válida.
  it("acepta más puntos que el catálogo casual", () => {
    const config = configOf(requestOf({ ...tournament, rules: { pointsToWin: 150 } }));
    expect(config.pointsToWin).toBe(150);
  });

  it.each([
    ["con rateId", { rateId: "r" }],
    ["con gameModeId", { gameModeId: "mode-2p" }],
    ["con niveles de aumento", { betLevels: [] }],
    ["con entryFee", { entryFee: 1 }],
    ["sin torneo", { tournamentId: undefined }],
    ["torneo vacío", { tournamentId: " " }],
    ["sin reglas", { rules: undefined }],
    ["puntos en cero", { rules: { pointsToWin: 0 } }],
    ["puntos fraccionarios", { rules: { pointsToWin: 1.5 } }],
    ["puntos negativos", { rules: { pointsToWin: -1 } }],
    ["puntos fuera del rango seguro", { rules: { pointsToWin: Number.MAX_SAFE_INTEGER + 1 } }],
    ["reglas de más", { rules: { pointsToWin: 50, entryFee: 1 } }],
    ["un solo jugador", { participants: [participants[0]] }],
    ["tres jugadores", { participants: [...participants, { ...participants[0], userId: "x" }] }],
    ["el mismo jugador dos veces", { participants: [participants[0], participants[0]] }],
  ])("rechaza una de torneo %s", (_name, override) => {
    expect(() => requestOf({ ...tournament, ...override })).toThrow();
  });

  it("una casual con campos de torneo, o un modo desconocido, no pasa", () => {
    expect(() => requestOf({ ...request, tournamentId: "t-1" })).toThrow();
    expect(() => requestOf({ ...tournament, mode: "RANKED" })).toThrow();
  });

  it("sienta cuatro, por parejas", () => {
    const four = [
      ...participants,
      { userId: "max", displayName: "Max", currency: "VES" },
      { userId: "zoe", displayName: "Zoe", currency: "VES" },
    ];
    expect(configOf(requestOf({ ...tournament, participants: four })).seats).toHaveLength(4);
  });

  it("el snapshot de torneo se rebobina con su torneo; el torneo sin modo, o al revés, no", () => {
    const config = configOf(requestOf(tournament));
    expect(replayConfigOf(config)).toEqual(config);
    const { tournamentId: _t, ...withoutTournament } = config;
    expect(() => replayConfigOf(withoutTournament)).toThrow();
    const { mode: _m, ...withoutMode } = config;
    expect(() => replayConfigOf(withoutMode)).toThrow();
  });

  it("una casual sigue sin escribir `mode`: su snapshot es el de siempre", () => {
    expect(configFrom()).not.toHaveProperty("mode");
    expect(configFrom()).not.toHaveProperty("tournamentId");
  });
});
