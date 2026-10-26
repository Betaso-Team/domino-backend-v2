import { env } from "@/env";
import type { ColyseusTestServer } from "@colyseus/testing";
import { matchMaker } from "colyseus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type SeatedMatch,
  bootServer,
  clientOf,
  playerIdOf,
  rejoinAs,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

// LA CONEXIÓN DE CADA ASIENTO DE PUNTA A PUNTA: sockets de verdad que se cortan de verdad, y lo que
// queda en el registro. Los unitarios del monitor y de la regla miden el juicio; esto mide el
// CABLEADO —que la sala le pase a cada hook el código que de verdad recibió, y que el cierre del
// registro lo guarde—.
const PORT = 2640;
const base = `http://127.0.0.1:${PORT}`;
const KEY = { "x-internal-api-key": env.adminApiKey ?? "" };

type Doc = { readonly [key: string]: unknown };
type StoredEvent = { readonly kind: string; readonly [key: string]: unknown };
type StoredPlayer = {
  readonly id: string;
  readonly connection?: { readonly rtt: { samples: number; avgMs: number }; events: StoredEvent[] };
};

const recordOf = async (matchId: string): Promise<Doc | undefined> => {
  const response = await fetch(`${base}/internal/matches/${matchId}`, { headers: KEY });
  return response.status === 200 ? ((await response.json()) as { data: Doc }).data : undefined;
};
const closed = (record: Doc | undefined) =>
  record?.status === "finished" || record?.status === "aborted";

const connectedOf = (match: SeatedMatch, selector: string) =>
  match.serverState.players.find((player) => player.playerId === playerIdOf(match, selector))
    ?.connected;

// EL OTRO SE RETIRA, y eso cierra la partida y el registro: lo que se mide ya pasó antes.
async function closeBy(match: SeatedMatch, selector: string): Promise<StoredPlayer[]> {
  clientOf(match, selector).send("ABANDON", {});
  await waitUntil(async () => closed(await recordOf(match.config.matchId)), 3_000);
  const record = await recordOf(match.config.matchId);
  return (record?.players ?? []) as StoredPlayer[];
}
const eventsOf = (players: StoredPlayer[], match: SeatedMatch, selector: string) =>
  players.find((player) => player.id === playerIdOf(match, selector))?.connection?.events ?? [];

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(PORT);
});

afterAll(async () => {
  await server.shutdown();
});

describe("la conexión de cada asiento en el registro", () => {
  it("el registro guarda el ping de los dos asientos", async () => {
    const match = await seatPair(server, ["p1", "p2"]);
    await revealHands(match);
    // EL PRIMER SONDEO SALE AL CONECTAR, no a los 2 s: con los plazos de la suite la partida se
    // decide sola en menos de un segundo, y una así —también en producción— quedaba sin ping.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const players = await closeBy(match, "p2");

    for (const player of players) {
      expect(player.connection?.rtt.samples).toBeGreaterThanOrEqual(1);
      expect(player.connection?.rtt.avgMs).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);

  // `1001` no se puede mandar a mano —la API de WebSocket sólo acepta `1000` y `3000-4999`; el 1001
  // lo pone el navegador al navegar—, así que cerrar la app se mide con el `1000`, que la regla
  // juzga igual. Y el SDK no reintenta con `1000`: el jugador no vuelve.
  it("cerrar la app es intencional", async () => {
    const match = await seatPair(server, ["c1", "c2"]);
    await revealHands(match);

    clientOf(match, "c1").connection.close(1000);
    await waitUntil(() => connectedOf(match, "c1") === false, 3_000);

    const [drop] = eventsOf(await closeBy(match, "c2"), match, "c1");
    expect(drop).toMatchObject({
      kind: "DROPPED",
      closeCode: 1000,
      verdict: { blame: "INTENTIONAL", cause: "CLOSED_APP" },
    });
  }, 10_000);

  // EL `4010` QUE MANDA EL PROPIO SDK cuando el navegador dispara `offline`: es red, no apagado, y el
  // SDK reintenta solo, así que además queda la vuelta por `onReconnect`.
  it("quedarse offline es la red, y la vuelta queda anotada", async () => {
    const match = await seatPair(server, ["o1", "o2"]);
    await revealHands(match);
    const client = clientOf(match, "o1");
    // Ver `reconnection.e2e.test.ts`: con el `minUptime` de fábrica el SDK no reintenta en una sala
    // que vive menos de 5 s, y lo que se mide es la vuelta, no esa heurística.
    client.reconnection.minUptime = 0;

    client.connection.close(4010);
    await waitUntil(() => connectedOf(match, "o1") === false, 3_000);
    await waitUntil(() => connectedOf(match, "o1") === true, 5_000);

    const events = eventsOf(await closeBy(match, "o2"), match, "o1");
    expect(events[0]).toMatchObject({
      kind: "DROPPED",
      closeCode: 4010,
      verdict: { blame: "NETWORK", cause: "WENT_OFFLINE" },
    });
    expect(events[1]).toMatchObject({ kind: "RECONNECTED" });
  }, 15_000);

  it("un socket que muere de golpe es la red", async () => {
    const match = await seatPair(server, ["d1", "d2"]);
    await revealHands(match);
    clientOf(match, "d1").reconnection.enabled = false;

    // Del lado del SERVIDOR, como hace el transporte con el que dejó de contestar los pings.
    const room = matchMaker.getLocalRoomById(match.roomId);
    const playerId = playerIdOf(match, "d1");
    const socket = room?.clients.find(
      (client) => (client.userData as { playerId?: string } | undefined)?.playerId === playerId,
    );
    (socket?.ref as unknown as { terminate(): void }).terminate();
    await waitUntil(() => connectedOf(match, "d1") === false, 3_000);

    const [drop] = eventsOf(await closeBy(match, "d2"), match, "d1");
    expect(drop).toMatchObject({ kind: "DROPPED", closeCode: 1006, verdict: { blame: "NETWORK" } });
  }, 10_000);

  it("volver con otra sesión es caída y vuelta", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    await revealHands(match);

    await rejoinAs(server, match, "r1");

    const events = eventsOf(await closeBy(match, "r2"), match, "r1");
    expect(events.map((event) => event.kind)).toEqual(["DROPPED", "RECONNECTED"]);
    expect(events[0]).toMatchObject({ closeCode: null, replacedBySession: true });
  }, 10_000);
});
