import { DEFAULT_TOURNAMENT_CONFIG } from "@/features/tournament";
import { describe, expect, it } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { matchConfig } from "../../core/engine/tests/match-config-fixture";
import { RoundSummary } from "../../core/state";
import type { MatchState } from "../../core/state";
import type { CasualRoomOptions, TournamentRoomOptions } from "../../transports/match-contract";
import { registerCasualVeto, registerTournamentVeto } from "../veto";

// LOS DOS PRODUCTORES DEL VETO. El consumidor —`matchmakingSink`— ya existía y estos no: nadie
// emitía `CASUAL_PAIR_VETOED` ni `PAIR_VETOED`, así que los dos libros se leían siempre vacíos y
// el emparejador no evitaba a nadie nunca.
//
// Ese defecto no lo podía ver ningún test: leer un libro vacío es indistinguible de leer uno que
// funciona, y el consumidor compilaba solo. Lo que este archivo fija es que los eventos SALEN —
// que es lo único que distingue las dos situaciones desde afuera.

const stateOf = (): MatchState => createMatchState(matchConfig(["seat-1", "seat-2"]));

const CASUAL: CasualRoomOptions = {
  mode: "CASUAL",
  gameModeId: "clasica-2p",
  seats: ["seat-1", "seat-2"],
  seed: "s",
  pointsToWin: 100,
  entryFee: 125,
  prize: 250,
  rankingWeight: 1,
  isFreeRoom: false,
};

const TOURNAMENT: TournamentRoomOptions = {
  mode: "TOURNAMENT",
  tournamentId: "t1",
  seats: ["seat-1", "seat-2"],
  seed: "s",
  pointsToWin: 100,
  pointsPerLoss: 1,
};

const resolved = { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" } as const;

describe("el veto casual", () => {
  // TERMINAR UNA PARTIDA NORMAL NO VETA A NADIE, y es toda la regla: el objetivo no es prohibir
  // que dos se vuelvan a cruzar —el emparejador junta a quien haya— sino desalentar REPETIR.
  // Vetar en la primera vaciaría el pozo de rivales de cualquiera que juegue seguido.
  it("no veta cuando la partida no era la revancha", () => {
    expect(registerCasualVeto(CASUAL, stateOf())(resolved)).toEqual([]);
  });

  it("veta cuando la partida YA ERA la revancha", () => {
    const listener = registerCasualVeto({ ...CASUAL, rematchCount: 1 }, stateOf());

    expect(listener(resolved)).toEqual([
      { type: "CASUAL_PAIR_VETOED", playerIds: ["seat-1", "seat-2"] },
    ]);
  });

  // SOLO EL CIERRE CON VEREDICTO. Una mesa que se cae sin ganador no es una repetición
  // sospechosa, es una sala que se murió — y vetar por eso castigaría al que se le cortó el wifi.
  it("no veta una partida que se abortó", () => {
    const listener = registerCasualVeto({ ...CASUAL, rematchCount: 1 }, stateOf());

    expect(listener({ type: "MATCH_ABORTED", reason: "INTERRUPTED" })).toEqual([]);
  });
});

describe("el veto de torneo", () => {
  // Ataca otro abuso: dos cómplices que se enfrentan y uno se rinde en treinta segundos para
  // inflar la tabla. Una partida corta y de pocas manos entre los mismos dos es la firma.
  const vetoOf = (roundsPlayed: number, durationMs: number) => {
    const match = stateOf();
    // El reloj arranca en cero y `now` devuelve la duración: es lo mismo que mide `computeQuality`.
    match.startedAt = 0;
    // NODOS DE VERDAD y no literales: el `ArraySchema` valida el tipo al insertar, así que un
    // `{}` casteado revienta al push. Lo único que `computeQuality` mira es el LARGO.
    for (let i = 0; i < roundsPlayed; i += 1) match.pastRounds.push(new RoundSummary());
    return registerTournamentVeto({
      options: TOURNAMENT,
      match,
      config: DEFAULT_TOURNAMENT_CONFIG,
      clock: { now: () => durationMs },
    })(resolved);
  };

  it("veta la partida corta y de pocas manos", () => {
    expect(vetoOf(0, 1_000)).toEqual([
      { type: "PAIR_VETOED", tournamentId: "t1", playerIds: ["seat-1", "seat-2"] },
    ]);
  });

  // UNA PARTIDA DE VERDAD NO SE VETA, y sin este caso el test de arriba pasaría verde con un
  // productor que veta SIEMPRE — que es peor que no vetar: le vaciaría el pozo de rivales a todo
  // el torneo.
  it("no veta una partida larga y disputada", () => {
    const largo = DEFAULT_TOURNAMENT_CONFIG.avgDurationMinutes * 60_000 * 3;

    expect(vetoOf(DEFAULT_TOURNAMENT_CONFIG.avgRounds * 3, largo)).toEqual([]);
  });

  it("no veta una partida que se abortó", () => {
    const listener = registerTournamentVeto({
      options: TOURNAMENT,
      match: stateOf(),
      config: DEFAULT_TOURNAMENT_CONFIG,
      clock: { now: () => 1_000 },
    });

    expect(listener({ type: "MATCH_ABORTED", reason: "INTERRUPTED" })).toEqual([]);
  });
});
