import { matchMaker } from "@colyseus/core";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type SeatedMatch,
  bootServer,
  clientOf,
  historyOf,
  linesOf,
  revealHands,
  seatPair,
  turnHolderOf,
  waitUntil,
} from "./e2e-harness";

// LA CAÍDA QUE FUE CULPA NUESTRA NO SE PAGA CON LA PARTIDA. Si el reloj va a retirar a un jugador que
// está afuera porque se le cayó la conexión por un error o una sobrecarga del servidor, la partida se
// cancela —`INTERRUPTED`, con reembolso del orquestador— en vez de darle la derrota. El control es la
// misma escena con una caída de su red, que sigue siendo una derrota.
//
// Con los plazos de la suite (turno 600 ms + reserva 300 ms, ventana 0,5 s) el jugador ya está fuera
// de su ventana cuando el reloj llega: es el caso de quien no pudo volver.
let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2654);
});

afterAll(async () => {
  await server.shutdown();
});

// EL SOCKET DEL ASIENTO DEL LADO DEL SERVIDOR: el cliente no puede cerrar con un código del servidor.
function serverSocketOf(match: SeatedMatch, playerId: string) {
  const socket = matchMaker
    .getLocalRoomById(match.roomId)
    ?.clients.find(
      (client) => (client.userData as { playerId?: string } | undefined)?.playerId === playerId,
    );
  if (!socket) throw new Error(`sin socket para ${playerId}`);
  return socket.ref as unknown as { terminate(): void; close(code?: number): void };
}

async function dropTurnHolder(
  users: readonly [string, string],
  drop: (socket: ReturnType<typeof serverSocketOf>) => void,
) {
  const match = await seatPair(server, users);
  await revealHands(match);
  const holder = turnHolderOf(match);
  const other = match.config.seats.find(({ playerId }) => playerId !== holder)?.playerId ?? "";
  const cancelled: unknown[] = [];
  clientOf(match, other).onMessage("matchCancelled", (payload) => cancelled.push(payload));
  clientOf(match, holder).reconnection.enabled = false;
  drop(serverSocketOf(match, holder));
  await waitUntil(
    () => match.serverState.players.find((p) => p.playerId === holder)?.connected === false,
    3_000,
  );
  return { match, cancelled };
}

describe("el reloj iba a retirar a quien se cayó", () => {
  it("por un error del servidor: la partida se cancela, nadie pierde", async () => {
    const { match, cancelled } = await dropTurnHolder(["sf1", "sf2"], (socket) =>
      socket.close(4002),
    );
    const matchId = match.config.matchId;

    await waitUntil(async () => (await linesOf(matchId)).includes("SYSTEM MATCH_ABORTED"), 5_000);
    expect(
      (await historyOf(matchId)).find((entry) => entry.type === "MATCH_ABORTED")?.payload,
    ).toEqual({ reason: "INTERRUPTED" });
    expect(await linesOf(matchId)).not.toContain("SYSTEM MATCH_RESOLVED");
    expect(await linesOf(matchId)).not.toContain("SYSTEM ABANDON");
    // ANTES SE LE DIO LA RESERVA: el primer vencimiento la gastó (y quedó en el historial); recién el
    // que lo iba a retirar cancela.
    expect(await linesOf(matchId)).toContain("SYSTEM DEADLINE_EXPIRED");
    expect(cancelled).toEqual([{ reason: "INTERRUPTED" }]);
  }, 10_000);

  it("por su red: pierde por abandono, como siempre", async () => {
    const { match } = await dropTurnHolder(["sf3", "sf4"], (socket) => socket.terminate());
    const matchId = match.config.matchId;

    await waitUntil(async () => (await linesOf(matchId)).includes("SYSTEM MATCH_RESOLVED"), 5_000);
    expect(await linesOf(matchId)).toContain("SYSTEM ABANDON");
    expect(await linesOf(matchId)).not.toContain("SYSTEM MATCH_ABORTED");
  }, 10_000);
});
