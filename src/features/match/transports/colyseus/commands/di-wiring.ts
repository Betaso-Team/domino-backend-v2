import { DEFAULT_TOURNAMENT_CONFIG } from "@/features/tournament";
import type { Logger } from "@/logger";
import type { DependencyContainer } from "tsyringe";
import type { CommandName } from "../../../core/command";
import type { DominoMatchConfig, GlobalDominoConfig } from "../../../core/config";
import type { Clock } from "../../../core/engine/clock";
import type { TimeoutScheduler } from "../../../core/engine/timeout-scheduler";
import type { SchemaVisibilityController } from "../../../core/engine/visibility";
import type { MatchEvent } from "../../../core/events";
import type { MatchState } from "../../../core/state";
import { buildEngineGraph } from "../../../history/engine-factory";
import {
  type HistoryPort,
  type MatchEventSink,
  MatchHistory,
  type MatchPieces,
  type StandingsFeeds,
  registerCasualVeto,
  registerTournamentVeto,
  reportStandings,
} from "../../../network";
import type { NetworkMatchEvent } from "../../../network/events";
import type { MatchEventListener } from "../../../network/listeners";
import type { DominoRoomOptions } from "../../match-contract";
import { MessageRouter } from "../messages";
import { CommandCatalog } from "./catalog";
import { CommandHandler } from "./command-handler";
import { identityDecoder } from "./decoders";

export type MatchStarter = () => void;
export type MatchSeatGuard = (playerId: string) => boolean;
export type MatchHasOutcome = () => boolean;
// LO QUE LA SALA NECESITA DE LA REVANCHA, y son dos funciones y no el grafo: la sala no puede
// alcanzar al conductor, que es lo que `EngineGraph` dejó de publicar. La compuerta la escribe
// el coordinador de la red; el cierre lo dispara una desconexión, que es un hecho de
// plataforma que el motor no mira.
export type RematchCloser = () => readonly NetworkMatchEvent[];

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
  child.register<MatchStarter>("MatchStarter", { useValue: () => graph.begin() });
  child.register<MatchHasOutcome>("MatchHasOutcome", { useValue: () => graph.hasOutcome() });
  child.register<MatchSeatGuard>("MatchSeatGuard", {
    useValue: (playerId) => graph.isStillPlaying(playerId),
  });
  child.register("RematchDoor", { useValue: graph.rematchGate });
  child.register<RematchCloser>("RematchCloser", { useValue: () => graph.closeRematch() });
  child.register("Command:ABANDON", { useValue: graph.commands.ABANDON });
  child.register("Command:PLAY_TILE", { useValue: graph.commands.PLAY_TILE });
  child.register("Command:DRAW_TILE", { useValue: graph.commands.DRAW_TILE });
  child.register("Command:PASS", { useValue: graph.commands.PASS });
  child.register("Command:REVEAL_TILES", { useValue: graph.commands.REVEAL_TILES });
  child.register("Command:PROPOSE_BET_MULTIPLIER", {
    useValue: graph.commands.PROPOSE_BET_MULTIPLIER,
  });
  child.register("Command:RESPOND_BET_MULTIPLIER", {
    useValue: graph.commands.RESPOND_BET_MULTIPLIER,
  });
  child.register("Command:REQUEST_REMATCH", { useValue: graph.commands.REQUEST_REMATCH });
  child.register("Command:RESPOND_REMATCH", { useValue: graph.commands.RESPOND_REMATCH });

  // MatchDriver no se registra: la sala puede iniciar la partida por MatchStarter, pero
  // no puede alcanzar advance/timeout y saltarse los comandos. Ahora tampoco puede
  // hacerlo por atrás: `EngineGraph` ya no publica el conductor, solo `begin()`.
}

export function buildCatalog(child: DependencyContainer): CommandCatalog {
  return new CommandCatalog(
    {
      ABANDON: identityDecoder("ABANDON"),
      PLAY_TILE: identityDecoder("PLAY_TILE"),
      DRAW_TILE: identityDecoder("DRAW_TILE"),
      PASS: identityDecoder("PASS"),
      REVEAL_TILES: identityDecoder("REVEAL_TILES"),
      PROPOSE_BET_MULTIPLIER: identityDecoder("PROPOSE_BET_MULTIPLIER"),
      RESPOND_BET_MULTIPLIER: identityDecoder("RESPOND_BET_MULTIPLIER"),
      REQUEST_REMATCH: identityDecoder("REQUEST_REMATCH"),
      RESPOND_REMATCH: identityDecoder("RESPOND_REMATCH"),
    },
    {
      ABANDON: child.resolve("Command:ABANDON"),
      PLAY_TILE: child.resolve("Command:PLAY_TILE"),
      DRAW_TILE: child.resolve("Command:DRAW_TILE"),
      PASS: child.resolve("Command:PASS"),
      REVEAL_TILES: child.resolve("Command:REVEAL_TILES"),
      PROPOSE_BET_MULTIPLIER: child.resolve("Command:PROPOSE_BET_MULTIPLIER"),
      RESPOND_BET_MULTIPLIER: child.resolve("Command:RESPOND_BET_MULTIPLIER"),
      REQUEST_REMATCH: child.resolve("Command:REQUEST_REMATCH"),
      RESPOND_REMATCH: child.resolve("Command:RESPOND_REMATCH"),
    },
  );
}

// ARMA LA TABLA DEL SOCKET. Los verbos del dominó entran acá como entradas del router, no
// como su definición: mañana una reacción se registra en esta misma tabla con su propio
// decoder y su propio handler, y no hay ninguna lista de excepciones que tocar.
//
// Se recorre `catalog.names()` en vez de escribir los cinco a mano, y eso es lo que hace
// que sumar un verbo al motor lo rutee solo. El tipo mapeado del catálogo ya garantizó que
// están todos.
export function buildRouter(
  catalog: CommandCatalog,
  history: MatchHistory,
  notify: (events: readonly MatchEvent[]) => void,
): MessageRouter {
  const router = new MessageRouter();
  for (const name of catalog.names()) {
    registerVerb(router, catalog, name, history, notify);
  }
  return router;
}

// El genérico existe para que `N` quede FIJO entre el decoder y su handler. Sin esta
// función intermedia los dos se instancian por separado sobre la unión y el par deja de
// verse como un par: es la misma razón por la que `router.on` los recibe juntos.
function registerVerb<N extends CommandName>(
  router: MessageRouter,
  catalog: CommandCatalog,
  name: N,
  history: MatchHistory,
  notify: (events: readonly MatchEvent[]) => void,
): void {
  router.on(
    name,
    catalog.decoder(name),
    new CommandHandler(name, catalog.command(name), history, notify),
  );
}

export function buildPieces(child: DependencyContainer, emit: MatchEventSink): MatchPieces {
  const config = child.resolve<DominoMatchConfig>("Config");
  const match = child.resolve<MatchState>("MatchState");
  const clock = child.resolve<Clock>("Clock");
  const port = child.resolve<HistoryPort>("HistoryPort");
  const history = new MatchHistory(config.matchId, match, clock, port);

  // EL PRIMER LISTENER DEL REPO, y llena el hueco que este archivo tenía reservado. Los destinos
  // son del PROCESO —el publicador es único, el de liga no tiene estado— y lo que se arma por
  // partida es el traductor, que necesita el árbol y el snapshot de ESTA mesa.
  //
  // Se arma SIEMPRE, aunque los dos destinos falten: el listener anota lo que no puede reportar, y
  // saltearlo acá convertiría una instancia sin configurar en una que reporta en silencio nada.
  const feeds = child.resolve<StandingsFeeds>("StandingsFeeds");
  const options = child.isRegistered("RoomOptions")
    ? child.resolve<DominoRoomOptions>("RoomOptions")
    : undefined;

  // ⚠ EL CIERRE SE REPORTA POR LOS DOS CAMINOS, y hasta acá no: el port dejó este listener
  // detrás de un `isRegistered("RoomOptions") ? [] : [...]`, o sea que sólo corría en el camino
  // del REQUEST — el viejo — y nunca en el del emparejador, que es por donde nace toda mesa
  // casual desde que matchmaking existe. Las partidas reales no llegaban ni al ranking ni a la
  // liga, en silencio: un reporte que no sale no falla, sólo deja una fila que nadie escribe.
  //
  // Se arma SIEMPRE, aunque los dos destinos falten: el listener anota lo que no puede reportar,
  // y saltearlo convertiría una instancia sin configurar en una que reporta en silencio nada.
  const listeners: MatchEventListener[] = [
    reportStandings({
      config,
      match,
      ranking: feeds.ranking,
      leagues: feeds.leagues,
      log: child.resolve<Logger>("Logger"),
    }),
  ];

  // LOS DOS VETOS SÓLO EXISTEN CON `RoomOptions`, y no es una omisión del otro camino: los datos
  // con los que deciden —cuántas revanchas lleva la cadena, de qué torneo es la mesa— viven en
  // las opciones y el request no los tiene. Una mesa creada por request no es una mesa del
  // emparejador, así que no hay a quién evitar en una cola por la que no pasó.
  if (options?.mode === "CASUAL") listeners.push(registerCasualVeto(options, match));
  if (options?.mode === "TOURNAMENT") {
    listeners.push(
      registerTournamentVeto({
        options,
        match,
        config: DEFAULT_TOURNAMENT_CONFIG,
        clock,
      }),
    );
  }

  // `emit` sigue sin usarse: es el canal para el listener que PRODUZCA eventos, y el del cierre no
  // produce ninguno a propósito (las dos tablas son de plataforma y nadie de esta partida las mira).
  void emit;
  return { history, listeners, sinks: [(events) => history.events(events)] };
}
