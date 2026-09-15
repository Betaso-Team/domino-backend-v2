import { describe, expect, it } from "vitest";
import { configOf } from "./match-contract.js";

// LA ÚNICA FRONTERA que valida lo que matchmaking manda, y la que traduce la identidad
// externa —la pareja `{ platformId, userUuid }`— al id opaco con el que el motor juega.
// Todo lo que este test afirma es dinero: la moneda ya cobrada, la tasa de la mesa y los
// montos en UC COMPLETAS (`entryFee: 125` son 125 UC, no 1,25). El catálogo de v1 guarda
// UC enteras o con decimales, así que el contrato acepta cualquier número finito no
// negativo y no escala nada.
const valid = {
  mode: "CASUAL",
  matchId: "m1",
  gameModeId: "classic-2p",
  participants: [
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
  ],
  seed: "seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFee: 125,
  prize: 250,
} as const;

describe("configOf", () => {
  it("normaliza identidades externas a ids opacos reproducibles", () => {
    expect(configOf(valid).seats).toEqual([
      { ...valid.participants[0], playerId: "seat-1" },
      { ...valid.participants[1], playerId: "seat-2" },
    ]);
  });

  it("conserva moneda, rateId y montos UC exactamente", () => {
    const config = configOf(valid);
    expect(config.rateId).toBe(valid.rateId);
    expect(config.entryFee).toBe(125);
    expect(config.prize).toBe(250);
    expect(config.seats.map(({ currency }) => currency)).toEqual(["VES", "USD"]);
  });

  // EL DECIMAL ES UN MONTO VÁLIDO, y este test es el que separa la convención de v1 de la
  // que había acá: un modo productivo con `entryFee: 1.5` son UN UC Y MEDIO, no quince
  // centésimos. Las aserciones van como LITERAL —`1.5`, no `valid.entryFee / 100`— porque
  // recalcularlas con la escala del código acompañaría cualquier reintroducción del `* 100`
  // sin ponerse roja, que es exactamente el defecto que esta tarea vino a sacar.
  it("conserva los decimales finitos sin escalarlos", () => {
    const config = configOf({ ...valid, entryFee: 1.5, prize: 2.75 });
    expect(config.entryFee).toBe(1.5);
    expect(config.prize).toBe(2.75);
  });

  // OTRO PRINCIPAL CUALQUIERA, para armar mesas de largo distinto del válido. Cada uno es una
  // pareja nueva, así que lo único que estas filas ejercen es el LARGO — si reusaran una pareja
  // existente, el rechazo podría venir del control de duplicados y la fila mediría otra regla.
  const extra = (n: number) => ({
    platformId: "betaso",
    userUuid: `extra-${n}`,
    displayName: `Extra ${n}`,
    currency: "VES",
  });

  it.each<[string, Record<string, unknown>]>([
    ["rateId no UUID", { rateId: "actual" }],
    // LAS TRES DEL LARGO DE LA MESA. Sin ellas, borrar el `superRefine` de paridad deja la
    // suite entera en verde y una mesa de 3 revienta recién adentro de `assignTeams` — o sea
    // después de crear la sala, que es después del cobro.
    ["cantidad impar", { participants: [...valid.participants, extra(1)] }],
    ["un solo participante", { participants: [valid.participants[0]] }],
    [
      "cinco participantes",
      { participants: [...valid.participants, extra(1), extra(2), extra(3)] },
    ],
    // LAS CUATRO PUERTAS QUE QUEDAN ABIERTAS cuando la fracción deja de ser un error.
    // `NaN` e `Infinity` son montos que ningún pagador puede acreditar y que sobreviven a
    // cualquier aritmética posterior contaminándola; el negativo es un cobro al revés; y el
    // que se pasa del rango seguro es el que hace que dos montos distintos sean el mismo
    // número.
    ["UC no numérica", { entryFee: Number.NaN }],
    ["UC infinita", { prize: Number.POSITIVE_INFINITY }],
    ["UC insegura", { prize: Number.MAX_SAFE_INTEGER + 1 }],
    ["UC negativa", { prize: -1 }],
    [
      "currency vacía",
      { participants: [{ ...valid.participants[0], currency: " " }, valid.participants[1]] },
    ],
    [
      "platformId ausente",
      {
        participants: [{ ...valid.participants[0], platformId: undefined }, valid.participants[1]],
      },
    ],
    [
      "displayName ausente",
      {
        participants: [{ ...valid.participants[0], displayName: undefined }, valid.participants[1]],
      },
    ],
  ])("rechaza %s", (_name, override) => {
    expect(() => configOf({ ...valid, ...override })).toThrow();
  });

  // EL CASO QUE JUSTIFICA LA PAREJA: el mismo UUID puede existir en dos plataformas y ser
  // dos personas distintas con dos billeteras distintas. Lo que no puede repetirse es la
  // pareja entera — eso sería el mismo principal sentado dos veces en la misma mesa.
  it("acepta el mismo userUuid en plataformas distintas y rechaza la pareja duplicada", () => {
    expect(() => configOf(valid)).not.toThrow();
    expect(() =>
      configOf({ ...valid, participants: [valid.participants[0], valid.participants[0]] }),
    ).toThrow(/duplicada/);
  });

  // LA IDENTIDAD SE GUARDA NORMALIZADA. El asiento se compara contra lo que viene en el token,
  // así que un `platformId` con padding acá y sin padding allá sería el mismo jugador para el
  // validador y dos distintos para `onJoin` — asiento rechazado con la inscripción cobrada.
  it("normaliza los espacios de la identidad y deja la moneda intacta", () => {
    const padded = configOf({
      ...valid,
      participants: [
        { ...valid.participants[0], platformId: " betaso ", userUuid: "  same  " },
        valid.participants[1],
      ],
    });

    expect(padded.seats[0]).toMatchObject({ platformId: "betaso", userUuid: "same" });
  });

  // Y NORMALIZAR ANTES DE COMPARAR es lo que impide colar la misma pareja dos veces con un
  // espacio de más. `superRefine` recibe la salida del objeto, así que ve los valores ya
  // recortados; si corriera sobre la entrada, esta mesa pasaría y cobraría dos asientos al
  // mismo principal.
  it("el padding no alcanza para duplicar una pareja", () => {
    expect(() =>
      configOf({
        ...valid,
        participants: [valid.participants[0], { ...valid.participants[0], userUuid: " same " }],
      }),
    ).toThrow(/duplicada/);
  });

  // La moneda es un valor CONTABLE, no una llave: se conserva exactamente como se cobró.
  it("conserva la moneda tal cual, sin recortarla", () => {
    const config = configOf({
      ...valid,
      participants: [{ ...valid.participants[0], currency: " VES " }, valid.participants[1]],
    });

    expect(config.seats[0]?.currency).toBe(" VES ");
  });
});
