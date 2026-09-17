import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG, type DominoMatchConfig } from "../core/config.js";
import { replay } from "../history/replay.js";
import type { HistoryEntry } from "../network/history.js";
import { replayConfigOf } from "../transports/match-contract.js";
import golden from "./fixtures/golden-2p.json" with { type: "json" };

// El meta sale de `replayConfigOf` y NO de `configOf`: rebobinar una partida no puede depender del
// catálogo —el modo pudo haberse editado o dado de baja después—, así que lo que entra acá es el
// SNAPSHOT completo, con sus asientos numerados y su dinero adentro.
//
// La ventana de reparto TIENE QUE ESPEJAR PRODUCCIÓN, no la comodidad del test. Con `false`, el
// motor del replay saltearía la ventana y arrancaría en `PLAYING`; los dos `REVEAL_TILES` que la
// partida grabada tiene al principio caerían con `NOT_DEALING` y el replay no reproduciría nada.
// Armarlo con el contrato en vez de a mano es lo que impide que ese campo —o el `rateId`, o los
// montos— se escriba distinto acá.
const meta: DominoMatchConfig = replayConfigOf({
  matchId: "m-replay",
  gameModeId: "clasica-2p",
  seats: [
    {
      platformId: "betaso",
      userUuid: "u1",
      displayName: "Jugador u1",
      currency: "VES",
      playerId: "seat-1",
    },
    {
      platformId: "betaso",
      userUuid: "u2",
      displayName: "Jugador u2",
      currency: "VES",
      playerId: "seat-2",
    },
  ],
  seed: "seed-replay",
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  isDealWindowEnabled: true,
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFee: 125,
  prize: 250,
});

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
const reveals: readonly HistoryEntry[] = meta.seats.map(({ playerId }, index) =>
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
  //
  // El `meta` pasa por `replayConfigOf` y no por un cast: el fixture es un snapshot GRABADO, así
  // que validarlo mide además que lo que la sala escribió sigue siendo una mesa legible. Con el
  // cast, un golden al que le faltara un campo —o que lo trajera corrupto— reconstruía igual.
  it("reproduce la partida golden hasta el estado final exacto", () => {
    const state = replay({
      meta: replayConfigOf(golden.meta),
      // EL GOLDEN NO TRAE LOS PLAZOS QUE SE INVENTARON DESPUÉS de grabarlo, y no se lo
      // regraba por eso: un fixture golden vale justamente porque es viejo. Los plazos nuevos
      // —hoy `betResponseTimeoutMs`— entran por el default, y los que el golden SÍ trae le
      // ganan al default, que es lo que esta prueba mide.
      globalConfig: { ...DEFAULT_GLOBAL_CONFIG, ...golden.globalConfig },
      startedAt: golden.startedAt,
      entries: golden.entries as HistoryEntry[],
    });
    expect(state.toJSON()).toEqual(golden.finalState);
  });
});

// EL REPLAY NO CONSULTA EL CATÁLOGO, Y SE MIDE SOBRE LA LISTA EXACTA DE IMPORTS del entrypoint.
//
// "Nunca consulta `GameModeReader`" es una propiedad NEGATIVA, y un test de comportamiento no la
// puede probar: un reader envenenado que lanzara al llamarse sólo diría que HOY no se llama con
// esta entrada. Lo que sí la sostiene es estructural — `src/replay.ts` no importa nada de
// `features/game-mode`, así que no tiene con qué preguntar—, y la lista CERRADA es lo que obliga a
// que cualquier dependencia nueva pase por acá y por el argumento que la justifique.
//
// Lo que esta guarda no cubre, dicho para no creerle de más: un `await import()` dinámico o un
// `rootContainer.resolve("GameModeReader")` —el container ya está importado— pasarían verdes. Es
// el piso, no el techo; lo que de verdad sostiene la propiedad es que `replayConfigOf` sea puro y
// no pida un `GameMode`, que es lo que mide `match-contract.test.ts`.
describe("el CLI de replay: sus dependencias", () => {
  it("no consulta el catálogo de modos: rebobina con el snapshot grabado", () => {
    const source = readFileSync("src/replay.ts", "utf8");
    const imported = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);

    expect([...imported].sort()).toEqual([
      "./di-container.js",
      "./features/match/core/config.js",
      "./features/match/history/replay.js",
      "./features/match/network/history.js",
      "./features/match/transports/match-contract.js",
      "./logger.js",
    ]);
  });
});
