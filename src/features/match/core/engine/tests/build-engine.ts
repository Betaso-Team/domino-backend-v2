// src/features/match/core/engine/tests/build-engine.ts
// Fixture de los tests de engine: arma el grafo de actores sobre un MatchState de
// prueba, SIN tsyringe y sin levantar una Room. Es el espejo del wiring de producción.
import type { DominoMatchConfig, GlobalDominoConfig } from "../../config.js";
import { DEFAULT_GLOBAL_CONFIG } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { MatchState } from "../../state/index.js";
import type { Clock } from "../clock.js";
import { createMatchState } from "../genesis.js";
import { MatchDriver } from "../match/driver.js";
import { MatchPlayer } from "../match/player.js";
import { MatchReferee } from "../match/referee.js";
import { Player } from "../player-facade.js";
import { PlayerRepository } from "../player-repository.js";
import { Referee } from "../referee-facade.js";
import type { TimeoutScheduler } from "../timeout-scheduler.js";
import type { SchemaVisibilityController } from "../visibility.js";

export interface EngineHarness {
  readonly match: MatchState;
  readonly players: Player;
  readonly referee: Referee;
  readonly matchDriver: MatchDriver;
  /** Mueve el reloj a mano. Nada espera tiempo real. */
  readonly clockBox: { now: number };
  /** Los deadlines que el engine programó, en orden. */
  readonly scheduled: number[];
  /** Dispara el último vencimiento programado. */
  fireTimeout(): readonly MatchEvent[];
}

export function buildEngine(
  seats: string[] = ["u1", "u2"],
  overrides: Partial<GlobalDominoConfig> = {},
): EngineHarness {
  const globalConfig: GlobalDominoConfig = { ...DEFAULT_GLOBAL_CONFIG, ...overrides };
  // SEAT_ORDER y no SHUFFLED, a propósito: estos tests de engine prueban REGLAS de juego
  // (forfeit, rondas, turnos), no el sorteo. Con SHUFFLED, "u1" ganaría o perdería el
  // equipo según la permutación del seed, y las aserciones de team letter pasarían por
  // casualidad hasta que alguien toque el PRNG o la lista de seats. El sorteo tiene su
  // propio test dedicado en team-assignment.test.ts; acá la mesa tiene que ser predecible.
  const config: DominoMatchConfig = {
    matchId: "m-test",
    gameModeId: "test",
    seed: "seed-test",
    seats,
    pointsToWin: 100,
    teamAssignment: "SEAT_ORDER",
    isDealWindowEnabled: false,
  };
  const match = createMatchState(config);

  const clockBox = { now: 1_000 };
  const clock: Clock = { now: () => clockBox.now };

  const scheduled: number[] = [];
  let pending: (() => readonly MatchEvent[]) | undefined;
  // Scheduler NO-OP: registra el instante y guarda el callback, pero no espera.
  const scheduler: TimeoutScheduler = {
    schedule(at, onExpire) {
      scheduled.push(at);
      pending = onExpire;
    },
    cancel() {
      pending = undefined;
    },
  };

  const visibility: SchemaVisibilityController = { makePublic() {}, hide() {} };

  const matchReferee = new MatchReferee(match);
  const matchDriver = new MatchDriver(match, clock, scheduler, globalConfig, matchReferee);
  const repository = new PlayerRepository(seats, (playerId) => new MatchPlayer(playerId, match));
  const players = new Player(repository);
  const referee = new Referee(matchReferee);

  return {
    match,
    players,
    referee,
    matchDriver,
    clockBox,
    scheduled,
    fireTimeout() {
      if (!pending) throw new Error("no hay timeout programado");
      const run = pending;
      pending = undefined;
      return run();
    },
  };
}
