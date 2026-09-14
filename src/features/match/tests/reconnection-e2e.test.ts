import { CloseCode } from "@colyseus/sdk";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import {
  type SeatedMatch,
  bootServer,
  linesOf,
  rejoinAs,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2589);
});

afterAll(async () => {
  await server.shutdown();
});

const connectedOf = (state: MatchState, playerId: string) =>
  state.players.find((player) => player.playerId === playerId)?.connected;

// NINGUNO DE LOS TRES CAMINOS REVELA LAS DOS MANOS, y no es un olvido: con la ronda en
// PLAYING el plazo del turno son 600 ms + 300 de reserva en test, así que un jugador caído
// al que le toca jugar lo retira el motor antes de que alcance a volver, y el test mediría
// esa carrera y no la reconexión. Tapada, la mesa espera los 15 s de la ventana de reparto
// —el único plazo que no es configurable por entorno— y eso es margen de sobra para los
// 3 s de la ventana de reconexión. El camino 2, que sí necesita ver una mano, levanta las
// fichas de UN solo jugador: alcanza para que su vista tenga las siete y la ronda sigue
// en DEALING porque falta el otro.
describe("reconexión — los tres caminos", () => {
  // CAMINO 1: bache de red. El SDK reintenta solo sobre la MISMA instancia de Room,
  // con los callbacks intactos.
  it("un bache de red no cuesta la partida y dispara onDrop/onReconnect", async () => {
    const match = await seatPair(server, ["n1", "n2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    const client = clientOf(match, "n1");
    // El SDK se NIEGA a reintentar sobre una sala más joven que `minUptime` (5 s por
    // defecto): es una heurística contra el reconnect-loop en un servidor que rebota al
    // arrancar. Una mesa de test vive 200 ms, así que con el default este camino no mide
    // la reconexión: mide la heurística. Lo que está bajo prueba es la ventana del
    // SERVIDOR, no el backoff del cliente.
    client.reconnection.minUptime = 0;

    let dropped = false;
    let reconnected = false;
    client.onDrop(() => {
      dropped = true;
    });
    client.onReconnect(() => {
      reconnected = true;
    });

    // Cierre NO consentido: es lo que Colyseus trata como caída. SIN AWAIT: la promesa de
    // `leave()` resuelve por `onLeave`, y una caída con reintento armado no lo dispara
    // nunca —dispara `onDrop`—, así que esperarla cuelga el test hasta el timeout.
    void client.leave(false);

    await waitUntil(() => dropped, 3_000);
    // El corte lo ve primero el cliente —es su propio socket—; el servidor se entera un
    // viaje después. Afirmar `connected === false` en seco es una carrera que pierde.
    await waitUntil(() => connectedOf(match.serverState, "n1") === false, 3_000);
    // La partida sigue viva, y el reloj del juego no se pausó.
    expect(match.serverState.phase).toBe("PLAYING");
    expect(match.serverState.activeDeadline).toBeGreaterThan(0);

    await waitUntil(() => reconnected, 5_000);
    await waitUntil(() => connectedOf(match.serverState, "n1") === true, 3_000);
    expect(linesOf("m-n1-n2")).toContain("SYSTEM PLAYER_RECONNECTED");
  });

  // CAMINO 2: token perdido. Mide que el asiento reservado para la reconexión no le cierre
  // la puerta a su propio dueño: `hasReachedMaxClients()` suma `clients + reservedSeats`, así
  // que con la reserva viva el matchmaker rechaza el joinById con "is already full" y el
  // jugador queda fuera de SU propia partida. Lo sostiene el `maxClients = seats.length * 2`
  // de `onCreate`, VERIFICADO bajando ese factor a 1: el joinById lanza.
  //
  // LO QUE ESTE TEST **NO** MIDE es el `unlock()` de `onDrop`, aunque el plan diga que sí:
  // comentarlo deja la suite entera en verde, porque con el doble de cupos la sala nunca
  // llega a lockearse y no hay lock que deshacer. No se fuerza uno a mano para tener
  // cobertura —eso mediría el andamio del test y no la sala—. La condición exacta bajo la
  // cual esa línea vuelve a importar está escrita en `domino-room.ts`, arriba del `unlock()`.
  it("quien perdió su token vuelve por roomId", async () => {
    const match = await seatPair(server, ["t1", "t2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    const client = clientOf(match, "t1");
    // Solo t1 levanta sus fichas: su vista queda con las siete y la ronda sigue en DEALING.
    client.send("REVEAL_TILES", {});
    await waitUntil(() => seenTilesOf(match.serverState, "t1") === true, 3_000);

    // Perder el token ES no poder reintentar con él. Apagado el reintento automático, el
    // único camino de vuelta es el manual —joinById— que es justo el que se quiere medir.
    client.reconnection.enabled = false;
    await client.leave(false);
    await waitUntil(() => connectedOf(match.serverState, "t1") === false, 3_000);

    // Con un solo cupo por asiento, esta línea lanza.
    const back = await rejoinAs(server, match.roomId, "t1");

    await waitUntil(() => connectedOf(match.serverState, "t1") === true, 3_000);
    // Ve su mano completa: la vista es del ASIENTO y le esperó.
    const own = [...(back.state.players.find((p) => p.playerId === "t1")?.hand.tiles ?? [])];
    expect(own).toHaveLength(7);
  });

  // CAMINO 3: la ventana venció. Cerrar el socket NO es rendirse: al jugador lo
  // retira el motor por timeout, no el transporte.
  it("al vencer la ventana el jugador sigue en la partida", async () => {
    const match = await seatPair(server, ["e1", "e2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    const client = clientOf(match, "e1");
    // Un cliente que AGOTA sus reintentos: `maxRetries = 0` lo hace rendirse en el primer
    // intento y avisar con FAILED_TO_RECONNECT. `minUptime = 0` es lo que deja que llegue
    // hasta ahí — con el default ni siquiera intenta y cierra con ABNORMAL_CLOSURE, que
    // es otro caso. Nadie vuelve, así que la ventana del servidor vence sola.
    client.reconnection.minUptime = 0;
    client.reconnection.maxRetries = 0;

    let leaveCode: number | undefined;
    client.onLeave((code) => {
      leaveCode = code;
    });
    await client.leave(false);

    await waitUntil(() => leaveCode !== undefined, 3_000);
    expect(leaveCode).toBe(CloseCode.FAILED_TO_RECONNECT);

    // La ventana de producción son 120 s; para este test se baja por env. Hay que
    // ESPERARLA: hasta que vence, el asiento sigue reservado y no hay desconexión que leer.
    await waitUntil(() => linesOf("m-e1-e2").includes("SYSTEM PLAYER_DISCONNECTED"), 10_000);

    // NO fue expulsado del juego: sigue siendo jugador, y la partida sigue en pie.
    expect(match.serverState.players.find((p) => p.playerId === "e1")?.hasAbandoned).toBe(false);
    expect(match.serverState.phase).toBe("PLAYING");
  });
});

// El cliente de un asiento, o un fallo con nombre. `SeatedMatch.clients` está indexado por
// string, así que leerlo devuelve `T | undefined` y cada uso pediría un `?.` que convierte
// "el asiento no existe" en "no pasó nada" — y un test que no hace nada es un test verde.
function clientOf(match: SeatedMatch, playerId: string): SeatedMatch["clients"][string] {
  const client = match.clients[playerId];
  if (!client) throw new Error(`sin cliente para el asiento ${playerId}`);
  return client;
}

const seenTilesOf = (state: MatchState, playerId: string) =>
  state.players.find((player) => player.playerId === playerId)?.hasSeenTiles;
