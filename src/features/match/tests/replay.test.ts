import { describe, expect, it } from "vitest";
import type { DominoMatchConfig } from "../core/config.js";
import { replay } from "../history/replay.js";
import type { HistoryEntry } from "../network/history.js";
import golden from "./fixtures/golden-2p.json" with { type: "json" };

const meta: DominoMatchConfig = {
  matchId: "m-replay",
  gameModeId: "clasica-2p",
  seed: "seed-replay",
  seats: ["u1", "u2"],
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  // TIENE QUE ESPEJAR PRODUCCIÓN, no la comodidad del test. Con `false`, el motor del
  // replay saltearía la ventana y arrancaría en `PLAYING`; los dos `REVEAL_TILES` que la
  // partida grabada tiene al principio caerían con `NOT_DEALING` y el replay no
  // reproduciría nada. El config del replay es parte del contrato, igual que el `seed`.
  isDealWindowEnabled: true,
};

function entry(seq: number, rest: Partial<HistoryEntry>): HistoryEntry {
  return {
    matchId: meta.matchId,
    seq,
    at: 1_000 + seq,
    roundNumber: 1,
    source: "PLAYER",
    kind: "COMMAND",
    type: "REVEAL_TILES",
    payload: {},
    ...rest,
  };
}

// La mesa arranca TAPADA, así que levantar las fichas es el prólogo de toda partida
// reproducida: sin estos dos actos la ronda sigue en `DEALING` y no hay turno de nadie.
const reveals: readonly HistoryEntry[] = meta.seats.map((playerId, index) =>
  entry(index + 1, { type: "REVEAL_TILES", payload: { playerId } }),
);

describe("replay", () => {
  it("mismo seed reconstruye el mismo reparto sin reaplicar nada", () => {
    const a = replay({ meta, entries: [] });
    const b = replay({ meta, entries: [] });
    expect(a.toJSON()).toEqual(b.toJSON());
    expect(a.players.every((player) => player.hand.tiles.length === 7)).toBe(true);
  });

  it("reaplica un comando del historial", () => {
    const opened = replay({ meta, entries: reveals });
    const turnHolder = opened.currentRound?.currentTurn?.playerId;
    expect(turnHolder).toBeTruthy();
    const tile = opened.players.find((player) => player.playerId === turnHolder)?.hand.tiles.at(0);
    if (!tile) throw new Error("mano vacía");

    // Tablero vacío ⇒ cualquier ficha entra, y `playableSides` normaliza el lado a RIGHT.
    const entries: readonly HistoryEntry[] = [
      ...reveals,
      entry(reveals.length + 1, {
        type: "PLAY_TILE",
        payload: { playerId: turnHolder, left: tile.left, right: tile.right, side: "RIGHT" },
      }),
    ];
    const after = replay({ meta, entries });
    expect(after.currentRound?.board.tiles.length).toBe(1);
  });

  it("ignora los eventos que son consecuencia, porque se re-derivan", () => {
    const entries: readonly HistoryEntry[] = [
      entry(1, {
        source: "SYSTEM",
        kind: "EVENT",
        type: "ROUND_RESOLVED",
        payload: {
          roundNumber: 1,
          winnerId: "u1",
          winnerTeamId: "A",
          points: 10,
          reason: "DOMINO",
        },
      }),
    ];
    // No lanza y no acredita puntos: el evento no es una entrada del motor.
    expect(replay({ meta, entries }).scoreboard?.teamA).toBe(0);
  });

  // EL TEST DE REGRESIÓN. Una partida real grabada; si el motor cambia de forma que
  // no la reproduzca, esto falla y nombra la regla que se movió.
  //
  // El fixture lleva TODO lo que el motor necesita y el historial no dice: el config con
  // su seed, el `globalConfig` de la corrida que lo generó —sin él la reserva de tiempo
  // extra sería la de producción y no la del entorno de test— y el `startedAt`.
  it("reproduce la partida golden hasta el estado final exacto", () => {
    const state = replay({
      meta: golden.meta as DominoMatchConfig,
      globalConfig: golden.globalConfig,
      startedAt: golden.startedAt,
      entries: golden.entries as HistoryEntry[],
    });
    expect(state.toJSON()).toEqual(golden.finalState);
  });
});
