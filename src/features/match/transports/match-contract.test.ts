import { describe, expect, it } from "vitest";
import type { GameMode } from "../../game-mode/index.js";
import { configOf, replayConfigOf, requestOf } from "./match-contract.js";

// LAS DOS FRONTERAS, y desde esta tarea son dos porque las entradas son dos cosas distintas.
//
// `requestOf` valida lo que matchmaking PIDE: una mesa, unos participantes y el NOMBRE de un modo.
// Ya no trae dinero ni puntos — el catálogo es la autoridad, y un request que pudiera declararlos
// sería un llamador inventándose la economía de la mesa—. `configOf` los copia del modo resuelto.
//
// `replayConfigOf` valida el snapshot YA GRABADO: la misma mesa, con sus asientos numerados y su
// dinero adentro. No consulta nada. Son dos funciones y no una con un parámetro opcional porque
// miden cosas distintas: una decide si una mesa puede NACER, la otra si un snapshot guardado se
// puede REBOBINAR, y el día que el catálogo cambie de reglas la segunda no puede cambiar con él.
const participants = [
  {
    platformId: "betaso",
    userUuid: "same",
    displayName: "Ada",
    username: "ada",
    profilePicture: "https://img.test/ada.png",
    currency: "VES",
  },
  {
    platformId: "partner",
    userUuid: "same",
    displayName: "Lin",
    currency: "USD",
  },
] as const;

const request = {
  mode: "CASUAL",
  matchId: "match-1",
  gameModeId: "mode-2p",
  participants,
  seed: "seed-1",
  teamAssignment: "SHUFFLED",
  rateId: "00000000-0000-4000-8000-000000000001",
} as const;

// EL MODO, escrito a mano y no traído del catálogo: esta suite mide la TRADUCCIÓN, no el
// repositorio. Los importes son UC completas (`entryFee: 125` son 125 UC) y difieren de todo lo
// que el request podría traer, que es lo que hace visible de dónde salió cada número.
const AT = new Date("2026-09-15T00:00:00.000Z");
const modeOf = (overrides: Partial<GameMode> = {}): GameMode => ({
  id: "0123456789abcdef01234567",
  uuid: "mode-2p",
  name: "clasica-2p",
  multiplier: 1,
  prize: 250,
  entryFee: 125,
  playersQuantity: 2,
  pointsToWin: 100,
  isActive: true,
  isFreeRoom: false,
  enableBots: false,
  createdAt: AT,
  updatedAt: AT,
  version: 0,
  ...overrides,
});

const configFrom = (input: unknown = request, mode: GameMode = modeOf()) =>
  configOf(requestOf(input), mode);

// OTRO PRINCIPAL CUALQUIERA, para armar mesas de largo distinto del válido. Cada uno es una
// pareja nueva, así que lo único que estas filas ejercen es el LARGO — si reusaran una pareja
// existente, el rechazo podría venir del control de duplicados y la fila mediría otra regla.
const extra = (n: number) => ({
  platformId: "betaso",
  userUuid: `extra-${n}`,
  displayName: `Extra ${n}`,
  currency: "VES",
});

describe("requestOf", () => {
  // EL DINERO Y LOS PUNTOS YA NO ENTRAN POR ACÁ, y este es el test que lo pinea. El `strictObject`
  // los rechaza en vez de ignorarlos: un request que los trae describe a un llamador que todavía
  // cree que puede fijar la economía de la mesa, y aceptarlos en silencio lo dejaría creerlo —con
  // los valores del catálogo pisándolos y nadie enterándose de la discrepancia.
  it.each<[string, Record<string, unknown>]>([
    ["pointsToWin", { pointsToWin: 7 }],
    ["entryFee", { entryFee: 1 }],
    ["prize", { prize: 2 }],
  ])("rechaza que el request traiga %s: eso lo decide el catálogo", (_name, override) => {
    expect(() => requestOf({ ...request, ...override })).toThrow();
  });

  it.each<[string, Record<string, unknown>]>([
    ["rateId no UUID", { rateId: "actual" }],
    ["gameModeId vacío", { gameModeId: " " }],
    // LAS TRES DEL LARGO DE LA MESA. Sin ellas, borrar el `superRefine` de paridad deja la
    // suite entera en verde y una mesa de 3 revienta recién adentro de `assignTeams` — o sea
    // después de crear la sala, que es después del cobro.
    ["cantidad impar", { participants: [...participants, extra(1)] }],
    ["un solo participante", { participants: [participants[0]] }],
    ["cinco participantes", { participants: [...participants, extra(1), extra(2), extra(3)] }],
    ["currency vacía", { participants: [{ ...participants[0], currency: " " }, participants[1]] }],
    [
      "platformId ausente",
      { participants: [{ ...participants[0], platformId: undefined }, participants[1]] },
    ],
    [
      "displayName ausente",
      { participants: [{ ...participants[0], displayName: undefined }, participants[1]] },
    ],
  ])("rechaza %s", (_name, override) => {
    expect(() => requestOf({ ...request, ...override })).toThrow();
  });

  // EL CASO QUE JUSTIFICA LA PAREJA: el mismo UUID puede existir en dos plataformas y ser
  // dos personas distintas con dos billeteras distintas. Lo que no puede repetirse es la
  // pareja entera — eso sería el mismo principal sentado dos veces en la misma mesa.
  it("acepta el mismo userUuid en plataformas distintas y rechaza la pareja duplicada", () => {
    expect(() => requestOf(request)).not.toThrow();
    expect(() =>
      requestOf({ ...request, participants: [participants[0], participants[0]] }),
    ).toThrow(/duplicada/);
  });

  // Y NORMALIZAR ANTES DE COMPARAR es lo que impide colar la misma pareja dos veces con un
  // espacio de más. `superRefine` recibe la salida del objeto, así que ve los valores ya
  // recortados; si corriera sobre la entrada, esta mesa pasaría y cobraría dos asientos al
  // mismo principal.
  it("el padding no alcanza para duplicar una pareja", () => {
    expect(() =>
      requestOf({
        ...request,
        participants: [participants[0], { ...participants[0], userUuid: " same " }],
      }),
    ).toThrow(/duplicada/);
  });
});

describe("configOf", () => {
  it("normaliza identidades externas a ids opacos reproducibles", () => {
    expect(configFrom().seats).toEqual([
      { ...participants[0], playerId: "seat-1" },
      { ...participants[1], playerId: "seat-2" },
    ]);
  });

  // EL CATÁLOGO ES LA AUTORIDAD, y esto es lo único que lo mide en aislamiento. Los tres números
  // salen del MODO y no del request, que ya ni siquiera puede nombrarlos: un llamador no puede
  // inventarse cuántos puntos vale la mesa ni cuánto cobra ni cuánto paga.
  //
  // Los valores van como LITERAL y no leídos del modo: recalcularlos con el mismo campo que la
  // implementación copia mediría que dos lecturas del mismo dato coinciden, y seguiría verde el
  // día que alguien vuelva a tomarlos del request.
  it("copia pointsToWin, entryFee y prize del modo", () => {
    const config = configFrom(request, modeOf({ pointsToWin: 33, entryFee: 1.5, prize: 2.75 }));
    expect(config.pointsToWin).toBe(33);
    expect(config.entryFee).toBe(1.5);
    expect(config.prize).toBe(2.75);
  });

  // EL `gameModeId` DEL SNAPSHOT ES EL DEL MODO RESUELTO y no el del request. Hoy son iguales
  // —la sala busca por ese uuid—, y esa es justamente la razón de escribir el resuelto: el día que
  // la resolución acepte un alias o un nombre, el snapshot tiene que guardar lo que se resolvió y
  // no lo que se pidió, o el replay rebobina una mesa que nunca existió.
  it("graba el modo que resolvió, no el que el request nombró", () => {
    expect(configFrom(request, modeOf({ uuid: "mode-resuelto" })).gameModeId).toBe("mode-resuelto");
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

  // LA IDENTIDAD SE GUARDA NORMALIZADA. El asiento se compara contra lo que viene en el token,
  // así que un `platformId` con padding acá y sin padding allá sería el mismo jugador para el
  // validador y dos distintos para `onJoin` — asiento rechazado con la inscripción cobrada.
  it("normaliza los espacios de la identidad y deja la moneda intacta", () => {
    const padded = configFrom({
      ...request,
      participants: [
        { ...participants[0], platformId: " betaso ", userUuid: "  same  ", currency: " VES " },
        participants[1],
      ],
    });

    expect(padded.seats[0]).toMatchObject({ platformId: "betaso", userUuid: "same" });
    // La moneda es un valor CONTABLE, no una llave: se conserva exactamente como se cobró.
    expect(padded.seats[0]?.currency).toBe(" VES ");
  });

  // ⚠ EL 4P SE RECHAZA ACÁ Y NO EN LA SALA, y la ubicación es la decisión. `configOf` es lo único
  // que ve el request Y el modo, y es por donde pasa TODA mesa que nace: rechazar en la sala
  // dejaría abierta cualquier segunda puerta de creación que aparezca. Es además donde ya vive la
  // comparación de cantidad, y partir dos reglas sobre los mismos dos datos en dos archivos es la
  // duplicación que este repo paga cada vez que la escribe.
  //
  // EL MOTIVO ES DINERO, no falta de motor: `settlementOf` exige EXACTAMENTE UN ganador, así que
  // el final de una mesa de cuatro lanza DESPUÉS del veredicto — sin premio (hubo desenlace) y sin
  // reembolso. Plata trabada. Rechazar antes de génesis es lo que mantiene esa deuda inerte, y
  // abrir el 4P de verdad es traer la regla del reparto, no borrar esta línea.
  it("rechaza un modo de cuatro con UNSUPPORTED_GAME_MODE", () => {
    expect(() =>
      configFrom(
        { ...request, participants: [...participants, extra(1), extra(2)] },
        modeOf({ playersQuantity: 4 }),
      ),
    ).toThrow(/UNSUPPORTED_GAME_MODE/);
  });

  // LA CANTIDAD LA DECIDE EL MODO. Sin esta guarda, un request de cuatro contra un modo de dos
  // sienta a cuatro personas en una mesa cuyo premio se calculó para dos: el motor arranca, la
  // partida se juega y la liquidación reparte mal.
  it.each<[string, readonly unknown[]]>([
    ["cuatro contra un modo de dos", [...participants, extra(1), extra(2)]],
  ])("rechaza %s", (_name, list) => {
    expect(() => configFrom({ ...request, participants: list })).toThrow(/SEAT_COUNT_MISMATCH/);
  });
});

// EL SNAPSHOT GRABADO, que es la otra mitad de la tarea: una partida tiene que poder rebobinarse
// sin catálogo. `replayConfigOf` valida la mesa ENTERA —asientos numerados, puntos y dinero
// adentro— y no consulta nada; es lo que permite que editar un modo no cambie una partida vieja.
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

  // EL SNAPSHOT DE ARRIBA ES UNO VIEJO A PROPÓSITO: no tiene los dos campos del aumento,
  // porque se grabó antes de que la feature existiera. Que rebobine igual —y que salga con el
  // aumento APAGADO— es la razón entera de que esos dos lleven default en el schema: sin
  // ellos, el día que se agregó la feature todos los goldens y toda la historia en Mongo
  // dejaban de poder reconstruirse, que es justo lo que el replay existe para poder hacer.
  //
  // Sigue siendo `toEqual` y no `toMatchObject`: lo que se agrega se escribe acá, así que un
  // campo que aparezca de más —o un grabado que se pierda— pone esto en rojo igual.
  it("reconstruye el snapshot completo tal cual se grabó, con el aumento apagado", () => {
    expect(replayConfigOf(snapshot)).toEqual({ ...snapshot, betLevels: [], isFreeRoom: false });
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
    ["rateId no UUID", { rateId: "actual" }],
    ["pointsToWin en cero", { pointsToWin: 0 }],
    ["ventana de reparto ausente", { isDealWindowEnabled: undefined }],
    ["asiento sin playerId", { seats: [{ ...participants[0] }, snapshot.seats[1]] }],
    ["cantidad impar", { seats: [snapshot.seats[0]] }],
  ])("rechaza %s", (_name, override) => {
    expect(() => replayConfigOf({ ...snapshot, ...override })).toThrow();
  });

  // EL DECIMAL ES UN MONTO VÁLIDO, y este test es el que separa la convención de v1 de la que
  // había acá: un modo productivo con `entryFee: 1.5` son UN UC Y MEDIO, no quince centésimos.
  it("conserva los decimales finitos sin escalarlos", () => {
    const config = replayConfigOf({ ...snapshot, entryFee: 1.5, prize: 2.75 });
    expect(config.entryFee).toBe(1.5);
    expect(config.prize).toBe(2.75);
  });
});
