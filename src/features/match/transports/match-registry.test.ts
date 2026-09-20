import { MemoryKeyValueStore } from "@/shared/kv";
import { describe, expect, it } from "vitest";
import { replayConfigOf } from "./match-contract";
import { HEARTBEAT_MS, MatchRegistry, TTL_SECONDS } from "./match-registry";

// El config se arma con el CONTRATO y no a mano: lo que el registro indexa son las parejas
// del snapshot REAL, y un objeto escrito a mano podría describir una mesa que el contrato
// ni siquiera aceptaría. Va por `replayConfigOf` —la entrada del snapshot ya congelado— y no por
// `configOf`, que desde la Tarea 10 pide además el `GameMode` resuelto: el registro indexa mesas
// que ya nacieron, no las hace nacer.
const seat = (userUuid: string, index: number, platformId = "betaso", currency = "VES") => ({
  platformId,
  userUuid,
  displayName: `Jugador ${userUuid}`,
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
// LA MESA QUE COLISIONARÍA con un índice por UUID pelado: el mismo `userUuid` en dos
// plataformas distintas, que son dos personas con dos billeteras.
const collidingConfig = replayConfigOf({
  ...roomOptions,
  seats: [seat("same", 0), seat("same", 1, "partner", "USD")],
});

const seatRef = (userUuid: string, platformId = "betaso") => ({ platformId, userUuid });

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
    await registry.register("room-1", config);

    expect(await registry.publicConfigOf("room-1")).toEqual({
      matchId: "m1",
      gameModeId: "clasica-2p",
      seats: ["seat-1", "seat-2"],
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });
  });

  // La allowlist ahora también decide qué SE ESCRIBE en el almacén compartido, no solo qué se
  // responde: se afirma sobre el contenido crudo de la clave porque un secreto que nunca se
  // sirve pero sí se guarda sigue siendo un secreto afuera del proceso.
  it("nunca serializa la semilla, ni siquiera en el almacén", async () => {
    const store = new MemoryKeyValueStore();
    const registry = new MatchRegistry(store);
    await registry.register("room-1", config);

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
    await registry.register("room-1", config);

    expect(await registry.matchOf(seatRef("u2"))).toBe("room-1");
    expect(await registry.matchOf(seatRef("u9"))).toBeUndefined();
  });

  it("deja de exponer una partida eliminada", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", config);

    await registry.remove("room-1");

    expect(await registry.publicConfigOf("room-1")).toBeUndefined();
    expect(await registry.matchOf(seatRef("u1"))).toBeUndefined();
  });

  // EL PUNTO ENTERO DEL INCREMENTO, y el único test que lo mide: dos registros distintos son dos
  // PROCESOS distintos, y el que no creó la sala tiene que contestar igual. Con el `Map` local de
  // antes esto daba `undefined` —o sea un 404 en `GET /config/:roomId`— con total confianza y
  // total falsedad.
  it("contesta por una sala que abrió otro proceso", async () => {
    const compartido = new MemoryKeyValueStore();
    const procesoA = new MatchRegistry(compartido);
    const procesoB = new MatchRegistry(compartido);

    await procesoA.register("room-1", config);

    expect(await procesoB.publicConfigOf("room-1")).toEqual({
      matchId: "m1",
      gameModeId: "clasica-2p",
      seats: ["seat-1", "seat-2"],
      pointsToWin: 100,
      entryFee: 125,
      prize: 250,
    });
    expect(await procesoB.matchOf(seatRef("u1"))).toBe("room-1");
  });

  // LO QUE DEJA ATRÁS UN PROCESO QUE MUERE DE GOLPE. `onDispose` no corre en un `kill -9`, así
  // que sin plazo la sala quedaría anunciada para siempre y sus jugadores presos de una partida
  // que ya no existe. El plazo es lo único que limpia ese caso sin un barrido.
  it("olvida la sala de un proceso que dejó de latir", async () => {
    const clock = fakeClock();
    const registry = new MatchRegistry(new MemoryKeyValueStore(clock.now));
    await registry.register("room-1", config);

    clock.advance(TTL_SECONDS * 1000 + 1);

    expect(await registry.publicConfigOf("room-1")).toBeUndefined();
    expect(await registry.matchOf(seatRef("u1"))).toBeUndefined();
  });

  // Y EL LATIDO ES LO QUE IMPIDE QUE ESO LE PASE A UNA SALA VIVA. Sin `keepAlive`, el plazo de
  // arriba vencería a los dos minutos en medio de una partida en curso.
  it("el latido renueva el plazo de una sala viva", async () => {
    const clock = fakeClock();
    const registry = new MatchRegistry(new MemoryKeyValueStore(clock.now));
    await registry.register("room-1", config);

    clock.advance(TTL_SECONDS * 1000 - 1);
    await registry.keepAlive("room-1");
    clock.advance(TTL_SECONDS * 1000 - 1);

    expect(await registry.publicConfigOf("room-1")).toBeDefined();
    expect(await registry.matchOf(seatRef("u1"))).toBe("room-1");
  });

  // LA MEMORIA QUE QUEDA ES DE ESCRITURA, y esto es lo que la define: un proceso solo renueva y
  // solo borra lo que ÉL anotó. Si `keepAlive` reviviera una sala ajena —o `remove` borrara una
  // ajena— cada instancia podría pisar el registro de las otras.
  it("no renueva ni borra lo que no escribió este proceso", async () => {
    const compartido = new MemoryKeyValueStore();
    const procesoA = new MatchRegistry(compartido);
    const procesoB = new MatchRegistry(compartido);
    await procesoA.register("room-1", config);

    await procesoB.keepAlive("room-1");
    await procesoB.remove("room-1");

    expect(await procesoA.publicConfigOf("room-1")).toBeDefined();
  });

  // LA PAREJA ES LA CLAVE, y el UUID solo no lo es: dos productos del Betaso comparten el
  // espacio de UUIDs, así que indexar por `userUuid` pelado sentaría al jugador de una
  // plataforma en la mesa de otro — y le daría su token de reconexión.
  it("indexa por la pareja y no mezcla UUID iguales de plataformas distintas", async () => {
    const registry = new MatchRegistry(new MemoryKeyValueStore());
    await registry.register("room-1", collidingConfig);

    expect(await registry.matchOf({ platformId: "betaso", userUuid: "same" })).toBe("room-1");
    expect(await registry.matchOf({ platformId: "partner", userUuid: "same" })).toBe("room-1");
    expect(await registry.matchOf({ platformId: "third", userUuid: "same" })).toBeUndefined();
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
    await registry.register("room-1", collidingConfig);
    const raw = await store.get("match_config:room-1");

    expect(raw).toBeDefined();
    for (const secret of ["betaso", "partner", "VES", "USD", collidingConfig.rateId]) {
      expect(raw).not.toContain(secret);
    }
    expect(JSON.parse(raw ?? "{}")).toMatchObject({ entryFee: 125, prize: 250 });
  });

  // Entre que un jugador dejó esta sala y que esta sala se entera, el jugador puede haberse
  // sentado en otra —en este proceso o en otro—. Borrar a ciegas lo dejaría sin partida justo
  // cuando acaba de empezar una, que es el peor momento posible.
  it("al cerrar una sala no suelta al jugador que ya está en otra", async () => {
    const compartido = new MemoryKeyValueStore();
    const vieja = new MatchRegistry(compartido);
    const nueva = new MatchRegistry(compartido);
    await vieja.register("room-1", config);
    await nueva.register(
      "room-2",
      replayConfigOf({
        ...roomOptions,
        matchId: "m2",
        seats: [seat("u1", 0), seat("u3", 1)],
      }),
    );

    await vieja.remove("room-1");

    expect(await nueva.matchOf(seatRef("u1"))).toBe("room-2");
    expect(await vieja.matchOf(seatRef("u2"))).toBeUndefined();
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

    await processA.register("room-1", config);
    await processB.register("room-2", otherMode);

    const census = await processA.census();
    expect(census.playersInMatch).toBe(4);
    expect([...census.byGameMode]).toEqual([
      ["clasica-2p", 2],
      ["rapida-2p", 2],
    ]);
  });

  it("deja de contar antes de barrer una sala que dejó de latir", async () => {
    const clock = fakeClock();
    const store = new MemoryKeyValueStore(clock.now);
    const registry = new MatchRegistry(store, clock.now);
    await registry.register("room-1", config);
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
    await registry.register("room-1", config);

    await registry.remove("room-1");

    expect(await registry.census()).toMatchObject({
      playersInMatch: 0,
      byGameMode: new Map(),
    });
  });
});
