import type { DependencyContainer } from "tsyringe";
import {
  AbandonCommand,
  DrawTileCommand,
  PassCommand,
  PlayTileCommand,
  RevealTilesCommand,
} from "../../../core/commands/index.js";
import type { DominoMatchConfig, GlobalDominoConfig } from "../../../core/config.js";
import type { Clock } from "../../../core/engine/clock.js";
import { Dealer } from "../../../core/engine/dealer.js";
import { MatchDriver, MatchPlayer, MatchReferee } from "../../../core/engine/match/index.js";
import { Player } from "../../../core/engine/player-facade.js";
import { PlayerRepository } from "../../../core/engine/player-repository.js";
import { Referee } from "../../../core/engine/referee-facade.js";
import { RoundDriver, RoundPlayer, RoundReferee } from "../../../core/engine/round/index.js";
import { Scorer } from "../../../core/engine/scorer.js";
import type { TimeoutScheduler } from "../../../core/engine/timeout-scheduler.js";
import type { SchemaVisibilityController } from "../../../core/engine/visibility.js";
import type { MatchState } from "../../../core/state/index.js";
import {
  type HistoryPort,
  type MatchEventSink,
  MatchHistory,
  type MatchPieces,
} from "../../../network/index.js";
import { CommandCatalog } from "./catalog.js";
import { identityDecoder } from "./decoders.js";

export type MatchStarter = () => void;
export type MatchSeatGuard = (playerId: string) => boolean;
export type MatchHasOutcome = () => boolean;

export function registerIndividualCommands(child: DependencyContainer): void {
  const match = child.resolve<MatchState>("MatchState");
  const config = child.resolve<DominoMatchConfig>("Config");
  const globalConfig = child.resolve<GlobalDominoConfig>("GlobalDominoConfig");
  const clock = child.resolve<Clock>("Clock");
  const scheduler = child.resolve<TimeoutScheduler>("TimeoutScheduler");

  const visibility = child.resolve<SchemaVisibilityController>("SchemaVisibilityController");
  const matchReferee = new MatchReferee(match);
  const roundReferee = new RoundReferee(match);
  const scorer = new Scorer(match);
  const dealer = new Dealer(match, config, globalConfig);
  const repository = new PlayerRepository(
    config.seats,
    (playerId) => new MatchPlayer(playerId, match),
    (playerId) => new RoundPlayer(playerId, match, visibility),
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee, roundReferee);
  const roundDriver = new RoundDriver(
    match,
    clock,
    globalConfig,
    config,
    roundReferee,
    dealer,
    scorer,
    (playerId) => repository.round(playerId),
  );
  const matchDriver = new MatchDriver(
    match,
    clock,
    scheduler,
    globalConfig,
    matchReferee,
    players,
    roundDriver,
  );

  child.register<Referee>("Referee", { useValue: referee });
  child.register<MatchStarter>("MatchStarter", { useValue: () => matchDriver.begin() });
  child.register<MatchHasOutcome>("MatchHasOutcome", {
    useValue: () => matchReferee.outcome() !== undefined,
  });
  child.register<MatchSeatGuard>("MatchSeatGuard", {
    useValue: (playerId) =>
      !match.players.find((player) => player.playerId === playerId)?.hasAbandoned,
  });
  child.register("Command:ABANDON", {
    useValue: new AbandonCommand(referee, players, matchDriver),
  });
  child.register("Command:PLAY_TILE", {
    useValue: new PlayTileCommand(referee, players, matchDriver),
  });
  child.register("Command:DRAW_TILE", {
    useValue: new DrawTileCommand(referee, players, matchDriver),
  });
  child.register("Command:PASS", {
    useValue: new PassCommand(referee, matchDriver),
  });
  child.register("Command:REVEAL_TILES", {
    useValue: new RevealTilesCommand(referee, players, matchDriver),
  });

  // MatchDriver no se registra: la sala puede iniciar la partida por MatchStarter, pero
  // no puede alcanzar advance/timeout y saltarse los comandos.
}

export function buildCatalog(child: DependencyContainer): CommandCatalog {
  return new CommandCatalog(
    {
      ABANDON: identityDecoder("ABANDON"),
      PLAY_TILE: identityDecoder("PLAY_TILE"),
      DRAW_TILE: identityDecoder("DRAW_TILE"),
      PASS: identityDecoder("PASS"),
      REVEAL_TILES: identityDecoder("REVEAL_TILES"),
    },
    {
      ABANDON: child.resolve("Command:ABANDON"),
      PLAY_TILE: child.resolve("Command:PLAY_TILE"),
      DRAW_TILE: child.resolve("Command:DRAW_TILE"),
      PASS: child.resolve("Command:PASS"),
      REVEAL_TILES: child.resolve("Command:REVEAL_TILES"),
    },
  );
}

export function buildPieces(child: DependencyContainer, emit: MatchEventSink): MatchPieces {
  const config = child.resolve<DominoMatchConfig>("Config");
  const match = child.resolve<MatchState>("MatchState");
  const clock = child.resolve<Clock>("Clock");
  const port = child.resolve<HistoryPort>("HistoryPort");
  const history = new MatchHistory(config.matchId, match, clock, port);

  // Los listeners por scope llegan en tareas posteriores; conservar la firma evita que
  // la sala tenga que cambiar cuando aparezcan.
  void emit;
  return { history, listeners: [], sinks: [(events) => history.events(events)] };
}
