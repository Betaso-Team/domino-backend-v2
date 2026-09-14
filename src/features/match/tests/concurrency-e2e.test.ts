import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type SeatedMatch,
  act,
  bootServer,
  clientOf,
  historyOf,
  legalPlayFor,
  revealHands,
  seatPair,
  turnHolderOf,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2588);
});

afterAll(async () => {
  await server.shutdown();
});

describe("concurrencia — no hay ventana para saltarse una validación", () => {
  // LA PREGUNTA ORIGINAL. El camino del comando es síncrono de punta a punta: sin
  // un solo await, Node no puede entrelazar dos mensajes del mismo cliente. El
  // primero muta el turno y los demás rebotan leyendo el estado YA mutado.
  it("N envíos de la misma jugada en el mismo tick aplican exactamente uno", async () => {
    const match = await seatPair(server, ["concurrency-c1", "concurrency-c2"]);
    // La mesa arranca TAPADA: `phase` es la de la PARTIDA y ya vale PLAYING con la ronda
    // todavía en DEALING, donde `currentTurn.playerId` no está asignado y no hay turno que
    // spamear. Sin esta línea el test no se cuelga: falla en seco con "sin jugada legal",
    // porque `legalPlayFor` no encuentra mano para un playerId `undefined`.
    await revealHands(match);

    const playerId = turnHolderOf(match);
    const play = legalPlayFor(match.serverState, playerId);
    if (!play) throw new Error("sin jugada legal");

    // El cliente se ata a una constante con guarda en vez de repetir `clients[id]?.`: con el
    // `?.`, un asiento mal escrito no manda nada y el test se cuelga en el `waitUntil` sin
    // decir por qué.
    const actor = clientOf(match, playerId);

    const illegal: { code: string }[] = [];
    actor.onMessage("illegal", (payload: { code: string }) => illegal.push(payload));

    // Veinte veces, sin await entre medio: todos salen en el mismo tick.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      actor.send("PLAY_TILE", play);
    }

    await waitUntil(() => illegal.length >= 19, 5_000);

    // UNA sola ficha en la mesa, y una sola entrada en el historial.
    expect(match.serverState.currentRound?.board.tiles.length).toBe(1);
    const plays = historyOf("m-concurrency-c1-concurrency-c2").filter(
      (entry) => entry.type === "PLAY_TILE",
    );
    expect(plays).toHaveLength(1);

    // Los 19 restantes rebotaron por regla de dominio, no por throttle: `maxMessagesPerSecond`
    // de la sala es `Infinity`, así que ningún envío se descartó en el transporte.
    expect(illegal).toHaveLength(19);
    for (const rejection of illegal) {
      expect(["NOT_YOUR_TURN", "TILE_NOT_IN_HAND"]).toContain(rejection.code);
    }
  });

  // La ráfaga se dispara UNA vez, en el hook, y los dos `it` afirman sobre lo que quedó.
  // Dentro del primero, el segundo —que lee el historial de ESTA mesa— dependería de que
  // el primero haya corrido: `vitest -t "rastro antifraude"` pasaría en vacío contra un
  // historial que nadie escribió. Es la misma corrección que la Tarea 20 le hizo al E2E
  // de la partida completa.
  describe("una ráfaga durante la pausa de la partida", () => {
    const MATCH_ID = "m-concurrency-k1-concurrency-k2";
    let match: SeatedMatch;
    const illegal: { code: string }[] = [];
    const seen: string[] = [];
    let tilesBefore = 0;

    beforeAll(async () => {
      match = await seatPair(server, ["concurrency-k1", "concurrency-k2"]);
      const actor = clientOf(match, "concurrency-k2");
      actor.onMessage("illegal", (payload: { code: string }) => illegal.push(payload));
      seen.push(match.serverState.phase);
      const observer = setInterval(() => seen.push(match.serverState.phase), 10);

      // Abandonar abre PRESENTING_MATCH, que es una fase de pausa: nada de juego es
      // legal ahí. Es el equivalente al hueco que el v1 dejaba con sleep(6000).
      //
      // Se espera con `act` —que compara la firma del estado— y no con un `waitUntil` sobre
      // `phase === "PRESENTING_MATCH"`: esa ventana dura `presentingMatchMs`, 120 ms en
      // test, así que un poll cada 10 ms puede llegar tarde y esperar para siempre una fase
      // que ya pasó a FINISHED.
      try {
        await act(match, "concurrency-k1", "ABANDON");

        tilesBefore = match.serverState.currentRound?.board.tiles.length ?? 0;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          actor.send("PLAY_TILE", { left: 6, right: 6, side: "RIGHT" });
        }

        await waitUntil(() => illegal.length >= 10, 5_000);
      } finally {
        clearInterval(observer);
      }
    });

    it("cae durante PRESENTING_MATCH, no toca el estado y rebota entera por regla de dominio", () => {
      expect(seen).toContain("PRESENTING_MATCH");
      expect(match.serverState.currentRound?.board.tiles.length).toBe(tilesBefore);
      expect(illegal).toHaveLength(10);
      for (const rejection of illegal) {
        expect(rejection.code).toBe("MATCH_NOT_IN_PROGRESS");
      }
    });

    it("los rechazos NO entran al historial: son rastro antifraude", () => {
      // El historial de ESTA mesa existe —el abandono lo escribió—, así que el cero de abajo
      // dice "no se grabó ninguna jugada" y no "no encontré la partida": con un matchId mal
      // escrito el filtro daría cero igual, y el test pasaría en vacío.
      const entries = historyOf(MATCH_ID);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.filter((entry) => entry.type === "PLAY_TILE")).toHaveLength(0);
    });
  });
});
