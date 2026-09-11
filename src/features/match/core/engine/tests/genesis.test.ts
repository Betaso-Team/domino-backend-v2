// src/features/match/core/engine/tests/genesis.test.ts
import { describe, expect, it } from "vitest";
import type { DominoMatchConfig } from "../../config.js";
import { createMatchState } from "../genesis.js";
// El test compara contra la política DIRECTAMENTE, y por eso la importa: así afirma que la
// génesis la DELEGA en vez de reimplementar `i % 2` y coincidir por casualidad.
import { assignTeams } from "../team-assignment.js";

const config = (
  seats: string[],
  overrides: Partial<DominoMatchConfig> = {},
): DominoMatchConfig => ({
  matchId: "m1",
  gameModeId: "clasica-2p",
  seed: "seed-1",
  seats,
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  isDealWindowEnabled: false,
  ...overrides,
});

describe("createMatchState", () => {
  it("sienta a los jugadores en el orden de seats", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.players.map((p) => p.playerId)).toEqual(["u1", "u2"]);
    expect(match.players.map((p) => p.seatIndex)).toEqual([0, 1]);
  });

  // La génesis NO decide los equipos: los delega en la política (spec §4.3). Lo que
  // este test protege es que los delegue de verdad y no reimplemente `i % 2`.
  it("aplica la política de equipos que dice el config", () => {
    const seats = ["u1", "u2", "u3", "u4"];
    const bySeat = createMatchState(config(seats, { teamAssignment: "SEAT_ORDER" }));
    expect(bySeat.players.map((p) => p.teamId)).toEqual(["A", "B", "A", "B"]);

    const shuffledMatch = createMatchState(config(seats, { teamAssignment: "SHUFFLED" }));
    expect(shuffledMatch.players.map((p) => p.teamId)).toEqual(
      assignTeams(seats, "SHUFFLED", "seed-1"),
    );
  });

  it("con el mismo seed, las parejas sorteadas son siempre las mismas", () => {
    const seats = ["u1", "u2", "u3", "u4"];
    expect(createMatchState(config(seats)).players.map((p) => p.teamId)).toEqual(
      createMatchState(config(seats)).players.map((p) => p.teamId),
    );
  });

  it("arranca en NOT_STARTED, sin ronda y sin marcador", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.phase).toBe("NOT_STARTED");
    expect(match.currentRound).toBeUndefined();
    // `scoreboard` es `t.ref().optional()` en el tipo, así que TS lo ve como
    // `Scoreboard | undefined` pese a que la génesis SIEMPRE lo instancia (Step 3).
    // El `?.` narrows sin non-null assertion (prohibido por lint): si la génesis
    // alguna vez dejara de instanciarlo, la comparación contra `undefined` falla
    // igual, en vez de crashear con un TypeError.
    expect(match.scoreboard?.teamA).toBe(0);
    expect(match.scoreboard?.teamB).toBe(0);
    expect(match.startedAt).toBe(0);
  });

  it("copia pointsToWin del config", () => {
    const match = createMatchState({ ...config(["u1", "u2"]), pointsToWin: 55 });
    expect(match.pointsToWin).toBe(55);
  });

  it("cada jugador nace con una mano vacía y no revelada", () => {
    const match = createMatchState(config(["u1", "u2"]));
    for (const player of match.players) {
      expect(player.hand.tiles.length).toBe(0);
      expect(player.hand.tileCount).toBe(0);
      expect(player.hand.isRevealed).toBe(false);
      expect(player.connected).toBe(true);
      expect(player.hasAbandoned).toBe(false);
    }
  });

  // La reserva de tiempo extra nace en 0 y la SIEMBRA el arranque de la partida
  // (`MatchDriver.begin`), que es quien tiene el `GlobalDominoConfig`. La génesis
  // recibe solo el config por partida, y no se le agrega un segundo parámetro para
  // esto: la reserva empieza a existir cuando la partida empieza, no cuando se
  // arma la mesa.
  it("la reserva de tiempo extra nace vacía; la siembra el arranque", () => {
    const match = createMatchState(config(["u1", "u2"]));
    for (const player of match.players) {
      expect(player.extraTimeRemainingMs).toBe(0);
    }
  });

  it("el seed NO entra al estado", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(JSON.stringify(match.toJSON())).not.toContain("seed-1");
  });
});
