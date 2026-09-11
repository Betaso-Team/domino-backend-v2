import type { DependencyContainer } from "tsyringe";
import { AbandonCommand } from "../../../core/commands/index.js";
import type { DominoMatchConfig, GlobalDominoConfig } from "../../../core/config.js";
import type { Clock } from "../../../core/engine/clock.js";
import { MatchDriver, MatchPlayer, MatchReferee } from "../../../core/engine/match/index.js";
import { Player } from "../../../core/engine/player-facade.js";
import { PlayerRepository } from "../../../core/engine/player-repository.js";
import { Referee } from "../../../core/engine/referee-facade.js";
import type { TimeoutScheduler } from "../../../core/engine/timeout-scheduler.js";
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

  const matchReferee = new MatchReferee(match);
  const matchDriver = new MatchDriver(match, clock, scheduler, globalConfig, matchReferee);
  const repository = new PlayerRepository(
    config.seats,
    (playerId) => new MatchPlayer(playerId, match),
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee);

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

  // MatchDriver no se registra: la sala puede iniciar la partida por MatchStarter, pero
  // no puede alcanzar advance/timeout y saltarse los comandos.
}

export function buildCatalog(child: DependencyContainer): CommandCatalog {
  return new CommandCatalog(
    { ABANDON: identityDecoder("ABANDON") },
    { ABANDON: child.resolve("Command:ABANDON") },
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
