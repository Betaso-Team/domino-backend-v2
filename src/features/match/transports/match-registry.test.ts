import { type KeyValueStore, MemoryKeyValueStore } from "@/shared/kv";
import { findBareAmounts } from "@/shared/tests/find-bare-amounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG } from "../core/config";
import { replayConfigOf } from "./match-contract";
import {
  HEARTBEAT_MS,
  MatchRegistry,
  TTL_SECONDS,
  publicConfigOf,
  publicTimeoutsOf,
} from "./match-registry";

// El config se arma con el CONTRATO y no a mano: lo que el registro indexa son las parejas
// del snapshot REAL, y un objeto escrito a mano podría describir una mesa que el contrato
// ni siquiera aceptaría. Va por `replayConfigOf` —la entrada del snapshot ya congelado— y no por
// `configOf`, que desde la Tarea 10 pide además el `GameMode` resuelto: el registro indexa mesas
// que ya nacieron, no las hace nacer.
// Las llaves que llevan plata en el mensaje `config`, para `findBareAmounts`.
const MONEY_KEYS = ["entryFee", "prize", "entry"];

const seat = (userId: string, index: number, currency = "VES") => ({
  userId,
  displayName: `Jugador ${userId}`,
  currency,
  playerId: `seat-${index + 1}`,
});

const roomOptions = {
  matchId: "m1",
  gameModeId: "clasica-2p",
  seats: [seat("u1", 0), seat("u2", 1)],
  seed: "secreto-que-no-sale",
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  isDealWindowEnabled: true,
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFee: 125,
  prize: 250,
} as const;

const config = replayConfigOf(roomOptions);
// Los plazos con los que nació la mesa. Distintos entre sí a propósito: con dos iguales, un campo
// cruzado con otro pasaría verde.
const timeouts = { turnMs: 45_000, extraTimeMs: 25_000, dealingMs: 15_000, betResponseMs: 8_000 };
// LA MESA CON DOS MONEDAS, para medir qué NO sale por el DTO público: identidad, moneda y
// tasa son privadas, y con las dos monedas distintas una fuga se ve por cualquiera de las dos.
const privateConfig = replayConfigOf({
  ...roomOptions,
  seats: [seat("u1", 0), seat("u2", 1, "USD")],
});

// Contra la implementación de MEMORIA del puerto, que no es un doble sino la del proceso
// único (ver `src/shared/kv.ts`). El reloj se inyecta para poder mover el plazo sin esperarlo.
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("MatchRegistry", () => {
  it("expone solo la configuración pública de una sala", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    expect(await registry.publicConfigOf("room-1")).toEqual({
      mode: "CASUAL",
      matchId: "m1",
      gameModeId: "clasica-2p",
      seats: ["seat-1", "seat-2"],
      pointsToWin: 100,
      entryFee: { uc: "125.0000" },
      prize: { uc: "250.0000" },
      betLevels: [],
      isFreeRoom: false,
      enableBots: false,
      timeouts: { turnMs: 45_000, extraTimeMs: 25_000, dealingMs: 15_000, betResponseMs: 8_000 },
    });
  });

  // LOS PLAZOS SALEN DE LA CONFIG QUE LA MESA FOTOGRAFIÓ, recortados: la config global también trae
  // pausas, revancha y la ventana de reconexión, que el front no usa y no tienen por qué viajar.
  it("publica solo los cuatro plazos de la config global", () => {
    expect(
      publicTimeoutsOf({
        ...DEFAULT_GLOBAL_CONFIG,
        turnTimeoutMs: 1,
        extraTimeReserveMs: 2,
        dealingTimeoutMs: 3,
        betResponseTimeoutMs: 4,
      }),
    ).toEqual({ turnMs: 1, extraTimeMs: 2, dealingMs: 3, betResponseMs: 4 });
  });

  it("no publica más que los plazos aunque reciba un objeto más ancho", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    const wider = { ...timeouts, presentingRoundMs: 4_000 };
    await registry.register("room-1", config, wider);

    expect((await registry.publicConfigOf("room-1"))?.timeouts).toEqual(timeouts);
  });

  // LOS NIVELES QUE LA MESA OFRECE, para pintar el aumento ANTES de proponer (truco `58ce78f`). Sale
  // el `level`, los puntos y el `extra` del catálogo, que el front muestra junto al nivel. El precio
  // lo deriva el cliente con `betAmountsOf`.
  it("publica los niveles de aumento con el extra", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register(
      "room-1",
      replayConfigOf({ ...roomOptions, betLevels: [{ level: 3, extra: 7, additionalPoints: 15 }] }),
      timeouts,
    );

    expect((await registry.publicConfigOf("room-1"))?.betLevels).toEqual([
      { level: 3, extra: 7, additionalPoints: 15 },
    ]);
  });

  // LAS DOS REGLAS DE LA MESA QUE EL FRONT NECESITA PARA DIBUJARLA: si es gratis (no hay aumento ni
  // entrada que mostrar) y si un retirado deja una máquina en su lugar.
  it("publica si la mesa es gratis y si sienta máquinas", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register(
      "room-1",
      replayConfigOf({ ...roomOptions, isFreeRoom: true, enableBots: true }),
      timeouts,
    );

    expect(await registry.publicConfigOf("room-1")).toMatchObject({
      isFreeRoom: true,
      enableBots: true,
    });
  });

  // EL PRECIO DE CADA ASIENTO EN SU MONEDA, por su id opaco: el front toma el suyo. Sólo los que lo
  // trajeron, sin nada más del asiento (ni `userId` ni nombre), y ausente si nadie lo trajo.
  it("publica el precio de cada asiento que lo trajo, por su id opaco y sin identidad", async () => {
    const price = {
      currency: "VES",
      rate: "200",
      entry: "25000.00",
      prize: "50000.00",
      levels: [{ level: 2, entry: "25000.00", prize: "100000.00" }],
    };
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register(
      "room-1",
      replayConfigOf({ ...roomOptions, seats: [{ ...seat("u1", 0), price }, seat("u2", 1)] }),
      timeouts,
    );

    // EN LA CONVENCIÓN DE MONTOS: la moneda como llave y el `uc` de la mesa al lado (subir a x2 cobra
    // 125 × 1 y paga 250 × 2), sin la `currency` hermana. Sin `decimals`, los textos salen como vinieron.
    const published = await registry.publicConfigOf("room-1");
    expect(published?.seatPrices).toEqual({
      "seat-1": {
        rate: "200",
        entry: { ves: "25000.00", uc: "125.0000" },
        prize: { ves: "50000.00", uc: "250.0000" },
        levels: [
          {
            level: 2,
            entry: { ves: "25000.00", uc: "125.0000" },
            prize: { ves: "100000.00", uc: "500.0000" },
          },
        ],
      },
    });
    expect(findBareAmounts(published, MONEY_KEYS)).toEqual([]);
    expect(JSON.stringify(published?.seatPrices)).not.toContain("u1");
    expect(await registry.publicConfigOf("room-404")).toBeUndefined();
  });

  // CON LOS DECIMALES DE LA MONEDA (aditivo del orquestador) el texto se rellena; nunca se recorta.
  it("rellena cada monto con los decimales de la moneda, si el precio los trae", () => {
    const price = {
      currency: "USD",
      rate: "1",
      entry: "125",
      prize: "250.5",
      levels: [{ level: 3, entry: "250", prize: "751.555" }],
      decimals: 2,
    };
    const published = publicConfigOf(
      replayConfigOf({
        ...roomOptions,
        seats: [{ ...seat("u1", 0, "USD"), price }, seat("u2", 1)],
      }),
      timeouts,
    );
    expect(published.seatPrices?.["seat-1"]).toEqual({
      rate: "1",
      entry: { usd: "125.00", uc: "125.0000" },
      prize: { usd: "250.50", uc: "250.0000" },
      levels: [
        {
          level: 3,
          entry: { usd: "250.00", uc: "250.0000" },
          prize: { usd: "751.555", uc: "750.0000" },
        },
      ],
    });
    expect(JSON.stringify(published)).not.toContain("decimals");
  });

  // NINGÚN MONTO SUELTO: todo lo que el mensaje `config` lleva de plata es un objeto por moneda. Los
  // `betLevels[].extra` no son plata (suman al multiplicador de puntos) y siguen siendo números.
  it("no publica ningún monto suelto", () => {
    const published = publicConfigOf(
      { ...config, betLevels: [{ level: 2, extra: 1, additionalPoints: 10 }] },
      timeouts,
    );
    expect(findBareAmounts(published, MONEY_KEYS)).toEqual([]);
    expect(published.betLevels).toEqual([{ level: 2, extra: 1, additionalPoints: 10 }]);
  });

  it("sin precio en ningún asiento no publica `seatPrices`", () => {
    expect(publicConfigOf(config, timeouts)).not.toHaveProperty("seatPrices");
  });

  // EL MISMO DTO PARA EL REGISTRO Y PARA EL MENSAJE `config` DE LA SALA: los dos salen de la función
  // pura, así que lo que estampa el almacén y lo que recibe el jugador al entrar no pueden divergir.
  it("publicConfigOf es lo que el registro estampa, y nunca lleva la semilla", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    const pure = publicConfigOf(config, timeouts);
    expect(await registry.publicConfigOf("room-1")).toEqual(pure);
    expect(JSON.stringify(pure)).not.toContain("secreto-que-no-sale");
    expect(pure).not.toHaveProperty("seed");
  });

  // La allowlist ahora también decide qué SE ESCRIBE en el almacén compartido, no solo qué se
  // responde: se afirma sobre el contenido crudo de la clave porque un secreto que nunca se
  // sirve pero sí se guarda sigue siendo un secreto afuera del proceso.
  it("nunca serializa la semilla, ni siquiera en el almacén", async () => {
    const store = new MemoryKeyValueStore();
    const registry = new MatchRegistry(store);
    await registry.register("room-1", config, timeouts);

    expect(JSON.stringify(await registry.publicConfigOf("room-1"))).not.toContain(
      "secreto-que-no-sale",
    );
    expect(await store.get("match_config:room-1")).not.toContain("secreto-que-no-sale");
  });

  it("devuelve undefined para una sala desconocida", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());

    expect(await registry.publicConfigOf("room-404")).toBeUndefined();
  });

  it("encuentra la sala activa de un jugador", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    expect(await registry.matchOf("u2")).toBe("room-1");
    expect(await registry.matchOf("u9")).toBeUndefined();
  });

  it("dice si la mesa de una partida sigue viva, por su matchId, en cualquier proceso", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    const registry = new MatchRegistry(store);
    expect(await registry.isLive("m1")).toBe(false);
    await registry.register("room-1", config, timeouts);
    expect(await registry.isLive("m1")).toBe(true);
    // Otro proceso, el mismo almacén.
    expect(await new MatchRegistry(store).isLive("m1")).toBe(true);
    await registry.remove("room-1");
    expect(await registry.isLive("m1")).toBe(false);
    // Y una sala que dejó de latir tampoco.
    await registry.register("room-2", config, timeouts);
    clock.advance(TTL_SECONDS * 1000 + 1);
    expect(await registry.isLive("m1")).toBe(false);
  });

  it("deja de exponer una partida eliminada", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    await registry.remove("room-1");

    expect(await registry.publicConfigOf("room-1")).toBeUndefined();
    expect(await registry.matchOf("u1")).toBeUndefined();
  });

  // EL PUNTO ENTERO DEL INCREMENTO, y el único test que lo mide: dos registros distintos son dos
  // PROCESOS distintos, y el que no creó la sala tiene que contestar igual. Con el `Map` local de
  // antes esto daba `undefined` —o sea un 404 en `GET /config/:roomId`— con total confianza y
  // total falsedad.
  it("contesta por una sala que abrió otro proceso", async () => {
    const compartido = new MemoryKeyValueStore();
    const procesoA = new MatchRegistry(compartido);
    const procesoB = new MatchRegistry(compartido);

    await procesoA.register("room-1", config, timeouts);

    expect(await procesoB.publicConfigOf("room-1")).toEqual({
      mode: "CASUAL",
      matchId: "m1",
      gameModeId: "clasica-2p",
      seats: ["seat-1", "seat-2"],
      pointsToWin: 100,
      entryFee: { uc: "125.0000" },
      prize: { uc: "250.0000" },
      betLevels: [],
      isFreeRoom: false,
      enableBots: false,
      timeouts,
    });
    expect(await procesoB.matchOf("u1")).toBe("room-1");
  });

  // LO QUE DEJA ATRÁS UN PROCESO QUE MUERE DE GOLPE. `onDispose` no corre en un `kill -9`, así
  // que sin plazo la sala quedaría anunciada para siempre y sus jugadores presos de una partida
  // que ya no existe. El plazo es lo único que limpia ese caso sin un barrido.
  it("olvida la sala de un proceso que dejó de latir", async () => {
    const clock = fakeClock();
    const registry = new MatchRegistry(new MemoryKeyValueStore(clock.now));
    await registry.register("room-1", config, timeouts);

    clock.advance(TTL_SECONDS * 1000 + 1);

    expect(await registry.publicConfigOf("room-1")).toBeUndefined();
    expect(await registry.matchOf("u1")).toBeUndefined();
  });

  // Y EL LATIDO ES LO QUE IMPIDE QUE ESO LE PASE A UNA SALA VIVA. Sin `keepAlive`, el plazo de
  // arriba vencería a los dos minutos en medio de una partida en curso.
  it("el latido renueva el plazo de una sala viva", async () => {
    const clock = fakeClock();
    const registry = new MatchRegistry(new MemoryKeyValueStore(clock.now));
    await registry.register("room-1", config, timeouts);

    clock.advance(TTL_SECONDS * 1000 - 1);
    await registry.keepAlive("room-1");
    clock.advance(TTL_SECONDS * 1000 - 1);

    expect(await registry.publicConfigOf("room-1")).toBeDefined();
    expect(await registry.matchOf("u1")).toBe("room-1");
  });

  // LA MEMORIA QUE QUEDA ES DE ESCRITURA, y esto es lo que la define: un proceso solo renueva y
  // solo borra lo que ÉL anotó. Si `keepAlive` reviviera una sala ajena —o `remove` borrara una
  // ajena— cada instancia podría pisar el registro de las otras.
  it("no renueva ni borra lo que no escribió este proceso", async () => {
    const compartido = new MemoryKeyValueStore();
    const procesoA = new MatchRegistry(compartido);
    const procesoB = new MatchRegistry(compartido);
    await procesoA.register("room-1", config, timeouts);

    await procesoB.keepAlive("room-1");
    await procesoB.remove("room-1");

    expect(await procesoA.publicConfigOf("room-1")).toBeDefined();
  });

  // LA CLAVE ES EL `userId`, y lo que se mide es que apunte a la sala en la que ese jugador se
  // sentó y que un tercero no aparezca en ninguna: devolver una sala de más le da al que
  // pregunta el token de reconexión de una partida ajena.
  //
  // Fue el test de la PAREJA `{ platformId, userId }` —`same` en dos plataformas eran dos
  // personas— y esa mesa hoy no se puede ni construir: `checkTableShape` rechaza el `userId`
  // repetido desde que la identidad se aplanó.
  it("indexa cada asiento por su userId y no inventa los que no se sentaron", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", privateConfig, timeouts);

    expect(await registry.matchOf("u1")).toBe("room-1");
    expect(await registry.matchOf("u2")).toBe("room-1");
    expect(await registry.matchOf("u3")).toBeUndefined();
  });

  // `entryFee` y `prize` son los dos montos PÚBLICOS, en las mismas UC completas que el
  // snapshot. Lo privado sigue siendo cómo se cobró a cada asiento: identidad, moneda y
  // tasa. Desde que el snapshot dejó los sufijos `*UcMinor`, el nombre del wire y el del
  // campo interno son el mismo, así que acá ya no hay un nombre interno que filtrar: lo que
  // se sigue midiendo es que el VALOR salga sin escalar y que la allowlist no deje pasar
  // nada más.
  it("publica los montos UC sin identidad, moneda ni tasa", async () => {
    const store = new MemoryKeyValueStore();
    const registry = new MatchRegistry(store);
    await registry.register("room-1", privateConfig, timeouts);
    const raw = await store.get("match_config:room-1");

    expect(raw).toBeDefined();
    for (const secret of ["u1", "u2", "VES", "USD", privateConfig.rateId]) {
      expect(raw).not.toContain(secret);
    }
    expect(JSON.parse(raw ?? "{}")).toMatchObject({
      entryFee: { uc: "125.0000" },
      prize: { uc: "250.0000" },
    });
  });

  // Entre que un jugador dejó esta sala y que esta sala se entera, el jugador puede haberse
  // sentado en otra —en este proceso o en otro—. Borrar a ciegas lo dejaría sin partida justo
  // cuando acaba de empezar una, que es el peor momento posible.
  it("al cerrar una sala no suelta al jugador que ya está en otra", async () => {
    const compartido = new MemoryKeyValueStore();
    const vieja = new MatchRegistry(compartido);
    const nueva = new MatchRegistry(compartido);
    await vieja.register("room-1", config, timeouts);
    await nueva.register(
      "room-2",
      replayConfigOf({
        ...roomOptions,
        matchId: "m2",
        seats: [seat("u1", 0), seat("u3", 1)],
      }),
      timeouts,
    );

    await vieja.remove("room-1");

    expect(await nueva.matchOf("u1")).toBe("room-2");
    expect(await vieja.matchOf("u2")).toBeUndefined();
  });

  // LO QUE DEJÓ UN PROCESO MUERTO, borrado por quien confirmó que su sala ya no existe (truco
  // `53d1030`). Solo la entrada que SIGUE apuntando a esa sala: el jugador puede haberse sentado en
  // otra mesa en el medio, y borrarla a ciegas lo dejaría sin partida.
  it("olvida la entrada de una sala muerta, y solo si sigue apuntando a ella", async () => {
    const compartido = new MemoryKeyValueStore();
    const muerto = new MatchRegistry(compartido);
    const vivo = new MatchRegistry(compartido);
    await muerto.register("room-1", config, timeouts);
    await vivo.register(
      "room-2",
      replayConfigOf({ ...roomOptions, matchId: "m2", seats: [seat("u2", 0), seat("u3", 1)] }),
      timeouts,
    );

    await vivo.forget("u1", "room-1");
    await vivo.forget("u2", "room-1");

    expect(await vivo.matchOf("u1")).toBeUndefined();
    expect(await vivo.matchOf("u2")).toBe("room-2");
  });
});

// LOS ASIENTOS QUE SE LIBERAN EN VIDA DE LA SALA. Una mesa que terminó sigue viva un rato —la
// ventana de revancha, el traspaso, los clientes que no se fueron— y mientras tanto su registro
// mandaba al jugador de vuelta a una partida terminada: el orquestador le devolvía ESE asiento y
// `onJoin` lo rechazaba con `PlayerAlreadyOutError`. Portado de truco.
describe("MatchRegistry: el latido suelta a quien ya no juega", () => {
  it("suelta al que dejó de estar activo y renueva al resto", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    await registry.keepAlive("room-1", ["u2"]);

    expect(await registry.matchOf("u1")).toBeUndefined();
    expect(await registry.matchOf("u2")).toBe("room-1");
  });

  it("con la partida terminada no queda nadie sentado, y la sala sigue respondiendo su config", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    await registry.keepAlive("room-1", []);

    expect(await registry.matchOf("u1")).toBeUndefined();
    expect(await registry.matchOf("u2")).toBeUndefined();
    expect(await registry.publicConfigOf("room-1")).toBeDefined();
  });

  // Soltado es para siempre: un latido posterior sin la lista —el de `rememberPlayer`— no puede
  // volver a sentarlo, o el jugador quedaría preso de la mesa vieja otra vez.
  it("un latido sin lista no revive a quien ya se soltó", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);
    await registry.keepAlive("room-1", ["u2"]);

    await registry.keepAlive("room-1");

    expect(await registry.matchOf("u1")).toBeUndefined();
    expect(await registry.matchOf("u2")).toBe("room-1");
  });

  it("no suelta al jugador que ya se sentó en otra mesa", async () => {
    const compartido = new MemoryKeyValueStore();
    const vieja = new MatchRegistry(compartido);
    const nueva = new MatchRegistry(compartido);
    await vieja.register("room-1", config, timeouts);
    await nueva.register(
      "room-2",
      replayConfigOf({ ...roomOptions, matchId: "m2", seats: [seat("u1", 0), seat("u3", 1)] }),
      timeouts,
    );

    await vieja.keepAlive("room-1", []);

    expect(await nueva.matchOf("u1")).toBe("room-2");
  });

  it("el censo cuenta solo a los que siguen jugando", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config, timeouts);

    await registry.keepAlive("room-1", ["u2"]);
    expect(await registry.census()).toMatchObject({ playersInMatch: 1 });

    await registry.keepAlive("room-1", []);
    expect(await registry.census()).toMatchObject({ playersInMatch: 0 });
  });
});

describe("MatchRegistry: censo del lobby", () => {
  it("suma asientos de todos los procesos y desglosa por modo", async () => {
    const store = new MemoryKeyValueStore();
    const processA = new MatchRegistry(store);
    const processB = new MatchRegistry(store);
    const otherMode = replayConfigOf({
      ...roomOptions,
      matchId: "m2",
      gameModeId: "rapida-2p",
      seats: [seat("u3", 0), seat("u4", 1)],
    });

    await processA.register("room-1", config, timeouts);
    await processB.register("room-2", otherMode, timeouts);

    const census = await processA.census();
    expect(census.playersInMatch).toBe(4);
    expect([...census.byGameMode]).toEqual([
      ["clasica-2p", 2],
      ["rapida-2p", 2],
    ]);
  });

  it("cuenta las mesas de torneo por torneo, y no por modo", async () => {
    const store = new MemoryKeyValueStore();
    const registry = new MatchRegistry(store);
    const tournament = replayConfigOf({
      ...roomOptions,
      mode: "TOURNAMENT",
      tournamentId: "t-1",
      matchId: "m3",
      gameModeId: "tournament:t-1",
      seats: [seat("u5", 0), seat("u6", 1)],
    });

    await registry.register("room-1", config, timeouts);
    await registry.register("room-3", tournament, timeouts);

    const census = await registry.census();
    expect(census.playersInMatch).toBe(4);
    expect([...census.byGameMode]).toEqual([["clasica-2p", 2]]);
    expect([...census.byTournament]).toEqual([["t-1", 2]]);
    expect(await registry.publicConfigOf("room-3")).toMatchObject({
      mode: "TOURNAMENT",
      tournamentId: "t-1",
    });
  });

  it("deja de contar antes de barrer una sala que dejó de latir", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    const registry = new MatchRegistry(store, clock.now);
    await registry.register("room-1", config, timeouts);
    await store.hset("live_seats", "corrupt", "{");

    clock.advance(2 * HEARTBEAT_MS + 1);
    expect(await registry.census()).toMatchObject({ playersInMatch: 0 });
    expect(await store.hgetall("live_seats")).toHaveProperty("room-1");
    expect(await store.hgetall("live_seats")).not.toHaveProperty("corrupt");

    clock.advance(2 * HEARTBEAT_MS);
    expect(await registry.census()).toMatchObject({ playersInMatch: 0 });
    expect(await store.hgetall("live_seats")).toEqual({});
  });

  it("al cerrar una sala la saca del censo en el acto", async () => {
    const store = new MemoryKeyValueStore();
    const registry = new MatchRegistry(store);
    await registry.register("room-1", config, timeouts);

    await registry.remove("room-1");

    expect(await registry.census()).toMatchObject({
      playersInMatch: 0,
      byGameMode: new Map(),
    });
  });
});

// EL CENSO POR (PROVEEDOR, MONEDA): el orquestador lo usa para saber, por proveedor, a cuántos
// jugadores puede enfrentar. Cuenta los mismos asientos activos que `playersInMatch`.
describe("MatchRegistry: censo por proveedor y moneda", () => {
  const withProvider = (userId: string, index: number, currency: string, providerId?: string) => ({
    ...seat(userId, index, currency),
    ...(providerId === undefined ? {} : { providerId }),
  });
  const mixed = replayConfigOf({
    ...roomOptions,
    seats: [withProvider("u1", 0, "VES", "betaso"), withProvider("u2", 1, "USD", "parley")],
  });

  it("suma los grupos de todos los procesos, y el asiento sin proveedor va con null", async () => {
    const store = new MemoryKeyValueStore();
    const processA = new MatchRegistry(store);
    const processB = new MatchRegistry(store);
    await processA.register("room-1", mixed, timeouts);
    await processB.register(
      "room-2",
      replayConfigOf({
        ...roomOptions,
        matchId: "m2",
        seats: [withProvider("u3", 0, "VES", "betaso"), withProvider("u4", 1, "VES")],
      }),
      timeouts,
    );

    const census = await processB.census();
    expect(census.playersInMatch).toBe(4);
    expect(census.groups).toEqual([
      { providerId: "betaso", currency: "VES", seats: 2 },
      { providerId: "parley", currency: "USD", seats: 1 },
      { providerId: null, currency: "VES", seats: 1 },
    ]);
  });

  it("las mesas de torneo cuentan en los mismos grupos que las casuales", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", mixed, timeouts);
    await registry.register(
      "room-3",
      replayConfigOf({
        ...roomOptions,
        mode: "TOURNAMENT",
        tournamentId: "t-1",
        matchId: "m3",
        gameModeId: "tournament:t-1",
        seats: [withProvider("u5", 0, "VES", "betaso"), withProvider("u6", 1, "USD", "parley")],
      }),
      timeouts,
    );

    expect((await registry.census()).groups).toEqual([
      { providerId: "betaso", currency: "VES", seats: 2 },
      { providerId: "parley", currency: "USD", seats: 2 },
    ]);
  });

  it("settle y keepAlive sacan de su grupo al que dejó de jugar", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", mixed, timeouts);

    await registry.settle("room-1", ["u2"]);
    expect((await registry.census()).groups).toEqual([
      { providerId: "parley", currency: "USD", seats: 1 },
    ]);

    // Un latido completo después no lo revive en su grupo.
    await registry.keepAlive("room-1", ["u1", "u2"]);
    expect((await registry.census()).groups).toEqual([
      { providerId: "parley", currency: "USD", seats: 1 },
    ]);

    await registry.keepAlive("room-1", []);
    expect(await registry.census()).toMatchObject({ playersInMatch: 0, groups: [] });
  });

  it("una entrada vieja, sin grupos, cuenta en el total y en ningún grupo", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    const registry = new MatchRegistry(store, clock.now);
    await registry.register("room-1", mixed, timeouts);
    await store.hset(
      "live_seats",
      "room-old",
      JSON.stringify({ seats: 2, gameModeId: "clasica-2p", at: clock.now() }),
    );

    const census = await registry.census();
    expect(census.playersInMatch).toBe(4);
    expect(census.groups).toEqual([
      { providerId: "betaso", currency: "VES", seats: 1 },
      { providerId: "parley", currency: "USD", seats: 1 },
    ]);
    expect(await store.hgetall("live_seats")).toHaveProperty("room-old");
  });

  it("una entrada con grupos rotos es una entrada rota: no cuenta y se barre", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    const registry = new MatchRegistry(store, clock.now);
    await registry.register("room-1", mixed, timeouts);
    const at = clock.now();
    const broken = {
      "not-array": { seats: 1, gameModeId: "x", groups: "betaso", at },
      "no-currency": { seats: 1, gameModeId: "x", groups: [{ providerId: "p", seats: 1 }], at },
      "bad-provider": {
        seats: 1,
        gameModeId: "x",
        groups: [{ providerId: 7, currency: "VES", seats: 1 }],
        at,
      },
      "bad-seats": {
        seats: 1,
        gameModeId: "x",
        groups: [{ providerId: null, currency: "VES", seats: "1" }],
        at,
      },
    };
    for (const [roomId, entry] of Object.entries(broken)) {
      await store.hset("live_seats", roomId, JSON.stringify(entry));
    }

    const census = await registry.census();
    expect(census.playersInMatch).toBe(2);
    expect(census.groups).toHaveLength(2);
    expect(Object.keys(await store.hgetall("live_seats"))).toEqual(["room-1"]);
  });

  it("una sala que dejó de latir sale de los grupos antes de barrerse", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    const registry = new MatchRegistry(store, clock.now);
    await registry.register("room-1", mixed, timeouts);

    clock.advance(2 * HEARTBEAT_MS + 1);
    expect(await registry.census()).toMatchObject({ playersInMatch: 0, groups: [] });
    expect(await store.hgetall("live_seats")).toHaveProperty("room-1");

    clock.advance(2 * HEARTBEAT_MS);
    expect(await registry.census()).toMatchObject({ groups: [] });
    expect(await store.hgetall("live_seats")).toEqual({});
  });

  it("el proveedor y la moneda no se confunden aunque se parezcan", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register(
      "room-1",
      replayConfigOf({
        ...roomOptions,
        seats: [withProvider("u1", 0, "VES", "null"), withProvider("u2", 1, "VES")],
      }),
      timeouts,
    );

    expect((await registry.census()).groups).toEqual([
      { providerId: "null", currency: "VES", seats: 1 },
      { providerId: null, currency: "VES", seats: 1 },
    ]);
  });
});

// UN ALMACÉN QUE CUENTA: envuelve al de memoria y anota cada llamada, para medir cuánto I/O cuesta
// cada latido. Las lecturas cuentan igual que las escrituras: un `get` también es un viaje a Redis.
function countingStore() {
  const inner = new MemoryKeyValueStore();
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push(`${name}:${String(args[0])}`);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Un tick de por medio, como la red: sin él todo resuelve en el acto y el paralelo no se ve.
      await Promise.resolve();
      try {
        return await fn(...args);
      } finally {
        inFlight -= 1;
      }
    };
  const store: KeyValueStore = {
    get: track("get", (key) => inner.get(key)),
    set: track("set", (key, value) => inner.set(key, value)),
    setex: track("setex", (key, value, seconds) => inner.setex(key, value, seconds)),
    del: (key) => {
      calls.push(`del:${key}`);
      inner.del(key);
    },
    sadd: track("sadd", (key, value) => inner.sadd(key, value)),
    srem: track("srem", (key, value) => inner.srem(key, value)),
    smembers: track("smembers", (key) => inner.smembers(key)),
    expire: track("expire", (key, seconds) => inner.expire(key, seconds)),
    hset: track("hset", (key, field, value) => inner.hset(key, field, value)),
    hgetall: track("hgetall", (key) => inner.hgetall(key)),
    hdel: track("hdel", (key, field) => inner.hdel(key, field)),
  };
  return {
    store,
    calls,
    maxInFlight: () => maxInFlight,
    reset: () => {
      calls.length = 0;
      maxInFlight = 0;
    },
  };
}

describe("MatchRegistry: el latido por hecho no escribe de más", () => {
  it("settle sin nadie que haya soltado no toca el almacén", async () => {
    const counting = countingStore();
    const registry = new MatchRegistry(counting.store);
    await registry.register("room-1", config, timeouts);
    counting.reset();

    await registry.settle("room-1", ["u1", "u2"]);
    // Un id que no es de esta mesa no cuenta como asiento nuevo: soltar es lo único que cambia.
    await registry.settle("room-1", ["u1", "u2", "u9"]);

    expect(counting.calls).toEqual([]);
  });

  it("settle suelta solo al que salió y reescribe el censo, sin renovar a nadie", async () => {
    const counting = countingStore();
    const registry = new MatchRegistry(counting.store);
    await registry.register("room-1", config, timeouts);
    counting.reset();

    await registry.settle("room-1", ["u2"]);

    expect(counting.calls).toEqual([
      "get:player_match:u1",
      "del:player_match:u1",
      "hset:live_seats",
    ]);
    expect(await registry.matchOf("u1")).toBeUndefined();
    expect(await registry.matchOf("u2")).toBe("room-1");
    expect(await registry.census()).toMatchObject({ playersInMatch: 1 });
  });

  // Soltar es irreversible también por `settle`: después de soltar, la misma lista ya no es cambio, y
  // un latido completo posterior no revive al soltado.
  it("lo soltado por settle queda soltado", async () => {
    const counting = countingStore();
    const registry = new MatchRegistry(counting.store);
    await registry.register("room-1", config, timeouts);
    await registry.settle("room-1", ["u2"]);
    counting.reset();

    await registry.settle("room-1", ["u2"]);
    await registry.settle("room-1", ["u1", "u2"]);
    expect(counting.calls).toEqual([]);

    await registry.keepAlive("room-1", ["u1", "u2"]);
    expect(await registry.matchOf("u1")).toBeUndefined();
    expect(await registry.matchOf("u2")).toBe("room-1");
  });

  it("settle no suelta al jugador que ya se sentó en otra mesa", async () => {
    const compartido = new MemoryKeyValueStore();
    const vieja = new MatchRegistry(compartido);
    const nueva = new MatchRegistry(compartido);
    await vieja.register("room-1", config, timeouts);
    await nueva.register(
      "room-2",
      replayConfigOf({ ...roomOptions, matchId: "m2", seats: [seat("u1", 0), seat("u3", 1)] }),
      timeouts,
    );

    await vieja.settle("room-1", []);

    expect(await nueva.matchOf("u1")).toBe("room-2");
    expect(await vieja.matchOf("u2")).toBeUndefined();
  });

  it("settle de una sala que este proceso no anotó no hace nada", async () => {
    const counting = countingStore();
    const registry = new MatchRegistry(counting.store);

    await registry.settle("room-x", []);

    expect(counting.calls).toEqual([]);
  });

  it("keepAlive escribe la config y los asientos en paralelo, y el censo al final", async () => {
    const counting = countingStore();
    const registry = new MatchRegistry(counting.store);
    await registry.register("room-1", config, timeouts);
    counting.reset();

    await registry.keepAlive("room-1", ["u2"]);

    // config + la sala de la partida + el `setex` de u2 + el `get` del release de u1, los cuatro a la vez.
    expect(counting.maxInFlight()).toBe(4);
    expect(counting.calls.at(-1)).toBe("hset:live_seats");
    expect(counting.calls).toHaveLength(6);
    expect(counting.calls).toEqual(
      expect.arrayContaining([
        "setex:match_config:room-1",
        "setex:match_room:m1",
        "setex:player_match:u2",
        "get:player_match:u1",
        "del:player_match:u1",
      ]),
    );
  });
});
