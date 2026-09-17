import type { Command, CommandName } from "../core/command";
import {
  AbandonCommand,
  DrawTileCommand,
  PassCommand,
  PlayTileCommand,
  ProposeBetMultiplierCommand,
  RespondBetMultiplierCommand,
  RevealTilesCommand,
} from "../core/commands/index";
import { type DominoMatchConfig, type GlobalDominoConfig, playerIdsOf } from "../core/config";
import { BetNegotiation, BetReferee } from "../core/engine/bet/index";
import type { Clock } from "../core/engine/clock";
import { Dealer } from "../core/engine/dealer";
import { createMatchState } from "../core/engine/genesis";
import { MatchDriver } from "../core/engine/match/driver";
import { MatchPlayer } from "../core/engine/match/player";
import { MatchReferee } from "../core/engine/match/referee";
import { Player } from "../core/engine/player-facade";
import { PlayerRepository } from "../core/engine/player-repository";
import { Referee } from "../core/engine/referee-facade";
import { RoundDriver } from "../core/engine/round/driver";
import { RoundPlayer } from "../core/engine/round/player";
import { RoundReferee } from "../core/engine/round/referee";
import { Scorer } from "../core/engine/scorer";
import type { TimeoutScheduler } from "../core/engine/timeout-scheduler";
import type { SchemaVisibilityController } from "../core/engine/visibility";
import type { MatchEvent } from "../core/events";
import type { PlayerId } from "../core/ids";
import type { MatchState } from "../core/state/index";

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
  const betReferee = new BetReferee(match, config);
  const bet = new BetNegotiation(match);
  const roundDriver = new RoundDriver(
    match,
    deps.clock,
    globalConfig,
    config,
    roundReferee,
    dealer,
    scorer,
    (playerId) => repository.round(playerId),
    bet,
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
      // LOS DOS DEL AUMENTO reciben el conductor de RONDA y no el de partida, que es la
      // diferencia de fondo con los otros cinco: congelar y descongelar mueve la fase de la
      // MANO, no la de la mesa. Y reciben el juez del aumento aparte del `Referee` general
      // porque éste no es un juez del juego: no mira fichas, mira dinero.
      PROPOSE_BET_MULTIPLIER: new ProposeBetMultiplierCommand(betReferee, bet, roundDriver),
      RESPOND_BET_MULTIPLIER: new RespondBetMultiplierCommand(betReferee, bet, roundDriver),
    },
  };
}
