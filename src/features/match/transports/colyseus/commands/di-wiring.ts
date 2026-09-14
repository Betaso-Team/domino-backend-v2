import type { DependencyContainer } from "tsyringe";
import type { DominoMatchConfig, GlobalDominoConfig } from "../../../core/config.js";
import type { Clock } from "../../../core/engine/clock.js";
import type { TimeoutScheduler } from "../../../core/engine/timeout-scheduler.js";
import type { SchemaVisibilityController } from "../../../core/engine/visibility.js";
import type { MatchState } from "../../../core/state/index.js";
import { buildEngineGraph } from "../../../history/engine-factory.js";
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

// Este archivo ya NO arma el grafo: lo pide a `buildEngineGraph` y solo decide qué queda
// alcanzable desde el container. La génesis y el orden de construcción viven en UN solo
// lugar, compartido con el replay; mientras estuvieron duplicados, cambiar una regla
// obligaba a acordarse del otro sitio —el bug que truco documenta—.
export function registerIndividualCommands(child: DependencyContainer): void {
  const config = child.resolve<DominoMatchConfig>("Config");
  const globalConfig = child.resolve<GlobalDominoConfig>("GlobalDominoConfig");
  const clock = child.resolve<Clock>("Clock");
  const scheduler = child.resolve<TimeoutScheduler>("TimeoutScheduler");
  const visibility = child.resolve<SchemaVisibilityController>("SchemaVisibilityController");

  const graph = buildEngineGraph(config, globalConfig, { clock, scheduler, visibility });

  // El árbol lo crea la fábrica, no la sala: la génesis es una regla del juego y tenerla
  // de los dos lados era la duplicación que este refactor cierra.
  child.register<MatchState>("MatchState", { useValue: graph.match });
  child.register("Referee", { useValue: graph.referee });
  child.register<MatchStarter>("MatchStarter", { useValue: () => graph.matchDriver.begin() });
  child.register<MatchHasOutcome>("MatchHasOutcome", { useValue: () => graph.hasOutcome() });
  child.register<MatchSeatGuard>("MatchSeatGuard", {
    useValue: (playerId) => graph.isStillPlaying(playerId),
  });
  child.register("Command:ABANDON", { useValue: graph.commands.ABANDON });
  child.register("Command:PLAY_TILE", { useValue: graph.commands.PLAY_TILE });
  child.register("Command:DRAW_TILE", { useValue: graph.commands.DRAW_TILE });
  child.register("Command:PASS", { useValue: graph.commands.PASS });
  child.register("Command:REVEAL_TILES", { useValue: graph.commands.REVEAL_TILES });

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
