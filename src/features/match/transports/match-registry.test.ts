import { describe, expect, it } from "vitest";
import { MemoryKeyValueStore } from "../../../shared/kv.js";
import { configOf } from "./match-contract.js";
import { MatchRegistry, TTL_SECONDS } from "./match-registry.js";

// El config se arma con `configOf` y no a mano: lo que el registro indexa son las parejas
// del snapshot REAL, y un objeto escrito a mano podría describir una mesa que el contrato
// ni siquiera aceptaría.
const participant = (userUuid: string) => ({
  platformId: "betaso",
  userUuid,
  displayName: `Jugador ${userUuid}`,
  currency: "VES",
});

const roomOptions = {
  mode: "CASUAL",
  matchId: "m1",
  gameModeId: "clasica-2p",
  participants: [participant("u1"), participant("u2")],
  seed: "secreto-que-no-sale",
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} as const;

const config = configOf(roomOptions);
// LA MESA QUE COLISIONARÍA con un índice por UUID pelado: el mismo `userUuid` en dos
// plataformas distintas, que son dos personas con dos billeteras.
const collidingConfig = configOf({
  ...roomOptions,
  participants: [
    { ...participant("same"), platformId: "betaso" },
    { ...participant("same"), platformId: "partner", currency: "USD" },
  ],
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

  // La allowlist del DTO público ahora también cubre DINERO. Se afirma sobre el contenido
  // crudo de la clave y no sobre la respuesta: un dato que nunca se sirve pero sí se
  // guarda sigue estando afuera del proceso, y el almacén lo comparte todo el clúster.
  it("no guarda identidad, moneda, tasa ni montos en la configuración pública", async () => {
    const store = new MemoryKeyValueStore();
    const registry = new MatchRegistry(store);
    await registry.register("room-1", collidingConfig);
    const raw = await store.get("match_config:room-1");

    expect(raw).toBeDefined();
    for (const secret of [
      "betaso",
      "partner",
      "VES",
      "USD",
      collidingConfig.rateId,
      "entryFeeUcMinor",
    ]) {
      expect(raw).not.toContain(secret);
    }
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
      configOf({
        ...roomOptions,
        matchId: "m2",
        participants: [participant("u1"), participant("u3")],
      }),
    );

    await vieja.remove("room-1");

    expect(await nueva.matchOf(seatRef("u1"))).toBe("room-2");
    expect(await vieja.matchOf(seatRef("u2"))).toBeUndefined();
  });
});
