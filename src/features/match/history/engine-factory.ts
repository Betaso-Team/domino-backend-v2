import type { Command, CommandName } from "../core/command.js";
import {
  AbandonCommand,
  DrawTileCommand,
  PassCommand,
  PlayTileCommand,
  RevealTilesCommand,
} from "../core/commands/index.js";
import { type DominoMatchConfig, type GlobalDominoConfig, playerIdsOf } from "../core/config.js";
import type { Clock } from "../core/engine/clock.js";
import { Dealer } from "../core/engine/dealer.js";
import { createMatchState } from "../core/engine/genesis.js";
import { MatchDriver } from "../core/engine/match/driver.js";
import { MatchPlayer } from "../core/engine/match/player.js";
import { MatchReferee } from "../core/engine/match/referee.js";
import { Player } from "../core/engine/player-facade.js";
import { PlayerRepository } from "../core/engine/player-repository.js";
import { Referee } from "../core/engine/referee-facade.js";
import { RoundDriver } from "../core/engine/round/driver.js";
import { RoundPlayer } from "../core/engine/round/player.js";
import { RoundReferee } from "../core/engine/round/referee.js";
import { Scorer } from "../core/engine/scorer.js";
import type { TimeoutScheduler } from "../core/engine/timeout-scheduler.js";
import type { SchemaVisibilityController } from "../core/engine/visibility.js";
import type { MatchEvent } from "../core/events.js";
import type { PlayerId } from "../core/ids.js";
import type { MatchState } from "../core/state/index.js";

export interface EngineGraph {
  readonly match: MatchState;
  /**
   * ARRANCAR la partida, y nada más. Antes acá salía el `MatchDriver` entero, y con él
   * `advance`/`timeout`: la sala podía hacer avanzar el juego sin pasar por un comando, y
   * el replay sin pasar por el historial. Es exactamente la protección que `di-wiring.ts`
   * se toma el trabajo de escribir —"MatchDriver no se registra"— y que esta interfaz
   * cedía por atrás; los dos consumidores solo llamaban `begin()`.
   */
  begin(): void;
  readonly referee: Referee;
  readonly commands: { readonly [N in CommandName]: Command<N, MatchEvent> };
  /** ¿Ya hay veredicto de partida? Lo pregunta la sala al disponerse, para no abortar lo ya dictaminado. */
  hasOutcome(): boolean;
  /** ¿Este asiento sigue jugando? Lo pregunta la sala en la puerta, antes de sentar a nadie. */
  isStillPlaying(playerId: PlayerId): boolean;
}

export interface EngineDeps {
  readonly clock: Clock;
  readonly scheduler: TimeoutScheduler;
  readonly visibility: SchemaVisibilityController;
}

// EN ORDEN DE DEPENDENCIA: jueces, servicios, conductores, players, facades, comandos.
// Es la única definición del grafo; la sala y el replay la comparten. Duplicarla era el
// bug que truco documenta: la misma regla escrita dos veces, obligada a coincidir sin que
// nada lo verifique.
//
// NO recibe container ni Colyseus: las tres dependencias que sí varían entre la sala y el
// replay —el reloj, el temporizador y la visibilidad— entran por `deps`, y son puertos.
export function buildEngineGraph(
  config: DominoMatchConfig,
  globalConfig: GlobalDominoConfig,
  deps: EngineDeps,
): EngineGraph {
  const match = createMatchState(config);
  const matchReferee = new MatchReferee(match);
  const roundReferee = new RoundReferee(match);
  const scorer = new Scorer(match);
  const dealer = new Dealer(match, config, globalConfig);
  const repository = new PlayerRepository(
    playerIdsOf(config),
    (playerId) => new MatchPlayer(playerId, match),
    (playerId) => new RoundPlayer(playerId, match, deps.visibility),
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee, roundReferee);
  const roundDriver = new RoundDriver(
    match,
    deps.clock,
    globalConfig,
    config,
    roundReferee,
    dealer,
    scorer,
    (playerId) => repository.round(playerId),
  );
  const matchDriver = new MatchDriver(
    match,
    deps.clock,
    deps.scheduler,
    globalConfig,
    matchReferee,
    players,
    roundDriver,
  );

  return {
    match,
    begin: () => matchDriver.begin(),
    referee,
    hasOutcome: () => matchReferee.outcome() !== undefined,
    isStillPlaying: (playerId) =>
      !match.players.find((player) => player.playerId === playerId)?.hasAbandoned,
    commands: {
      ABANDON: new AbandonCommand(referee, players, matchDriver),
      PLAY_TILE: new PlayTileCommand(referee, players, matchDriver),
      DRAW_TILE: new DrawTileCommand(referee, players, matchDriver),
      PASS: new PassCommand(referee, matchDriver),
      REVEAL_TILES: new RevealTilesCommand(referee, players, matchDriver),
    },
  };
}
