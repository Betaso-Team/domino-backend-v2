import type { Command, CommandName } from "../core/command";
import {
  AbandonCommand,
  DrawTileCommand,
  PassCommand,
  PlayTileCommand,
  ProposeBetMultiplierCommand,
  RespondBetMultiplierCommand,
  RevealTilesCommand,
} from "../core/commands";
import { RequestRematchCommand } from "../core/commands/request-rematch";
import { RespondRematchCommand } from "../core/commands/respond-rematch";
import { type DominoMatchConfig, type GlobalDominoConfig, playerIdsOf } from "../core/config";
import { BetNegotiation, BetReferee } from "../core/engine/bet";
import type { Clock } from "../core/engine/clock";
import { Dealer } from "../core/engine/dealer";
import { createMatchState } from "../core/engine/genesis";
import { MatchDriver } from "../core/engine/match/driver";
import { MatchPlayer } from "../core/engine/match/player";
import { MatchReferee } from "../core/engine/match/referee";
import { MoveLog } from "../core/engine/move-log";
import { Player } from "../core/engine/player-facade";
import { PlayerRepository } from "../core/engine/player-repository";
import { Referee } from "../core/engine/referee-facade";
import { RematchGate } from "../core/engine/rematch/gate";
import { RematchNegotiation } from "../core/engine/rematch/negotiation";
import { RematchReferee } from "../core/engine/rematch/referee";
import { RoundDriver } from "../core/engine/round/driver";
import { RoundPlayer } from "../core/engine/round/player";
import { RoundReferee } from "../core/engine/round/referee";
import { Scorer } from "../core/engine/scorer";
import type { TimeoutScheduler } from "../core/engine/timeout-scheduler";
import type { SchemaVisibilityController } from "../core/engine/visibility";
import type { MatchEvent } from "../core/events";
import type { PlayerId } from "../core/ids";
import type { MatchState } from "../core/state";

export interface EngineGraph {
  readonly match: MatchState;
  /**
   * LA COMPUERTA DE LA REVANCHA, y es lo ÚNICO del grafo que se escribe desde afuera.
   *
   * Sale acá porque su respuesta no es del juego: depende del saldo de los dos, del antifraude y
   * del tope de la cadena, o sea de varias idas y vueltas de red. La RED la contesta durante la
   * pausa de presentación y el conductor la lee al vencer esa pausa.
   *
   * No es la puerta trasera que `begin()` cerró: no hace avanzar nada ni mueve una fase. Deja un
   * booleano que el conductor consulta UNA vez.
   */
  readonly rematchGate: RematchGate;
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
  /**
   * LA REVANCHA YA NO ES POSIBLE, dicho desde afuera: un socket que se cayó mientras se
   * negociaba, o la apertura de la sala nueva que falló.
   *
   * Es la segunda excepción a «el grafo no deja mover el juego desde afuera», y se gana el lugar
   * por lo mismo que la compuerta: una desconexión es un hecho de PLATAFORMA y el motor no los
   * mira. Sin esto, el que ofreció se queda mirando una cuenta atrás que ya no puede terminar en
   * nada. Es inofensiva fuera de las fases de revancha.
   */
  closeRematch(): readonly MatchEvent[];
  /**
   * DESHACE EL AUMENTO YA ACORDADO, y es la tercera excepción a «el grafo no deja mover el juego
   * desde afuera» — por el mismo motivo que las otras dos: cobrar es RED, y el motor asentó el
   * trato sin poder esperarla.
   *
   * La pide el listener del cobro cuando la billetera dijo que no. Es idempotente y devuelve
   * vacío si no había nada acordado, así que llamarla de más no emite un evento de mentira.
   */
  revokeMultiplier(): readonly MatchEvent[];
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
  // EL REGISTRO NO SALE POR `EngineGraph`, y es deliberado: escribe y nadie lo lee del lado del
  // servidor, así que darle una puerta pública sería ofrecer una segunda forma de apuntar una jugada
  // —una que no pasa por el verbo— justo en el registro que el front lee como si fuera la verdad.
  // Lo reciben los TRES comandos que son jugadas, y ningún conductor.
  const moves = new MoveLog(match);
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
  // LOS DOS DE LA REVANCHA. La compuerta nace SABIENDO si la mesa la ofrece —del snapshot
  // congelado y no del modo, que el motor no conoce— y arranca sin permiso: hasta que la red
  // conteste, no hay revancha. Cerrado es el lado seguro en el que equivocarse.
  const gate = new RematchGate(config.isRematchEnabled);
  const rematch = new RematchNegotiation(match);
  const rematchReferee = new RematchReferee(match);
  const matchDriver = new MatchDriver(
    match,
    deps.clock,
    deps.scheduler,
    globalConfig,
    matchReferee,
    players,
    roundDriver,
    gate,
    rematch,
  );

  return {
    match,
    rematchGate: gate,
    begin: () => matchDriver.begin(),
    closeRematch: () => matchDriver.closeRematch().events,
    revokeMultiplier: () => {
      const level = bet.revoke();
      return level > 0 ? [{ type: "MULTIPLIER_REVOKED", level }] : [];
    },
    referee,
    hasOutcome: () => matchReferee.outcome() !== undefined,
    isStillPlaying: (playerId) =>
      !match.players.find((player) => player.playerId === playerId)?.hasAbandoned,
    commands: {
      ABANDON: new AbandonCommand(referee, players, matchDriver),
      PLAY_TILE: new PlayTileCommand(referee, players, matchDriver, moves),
      DRAW_TILE: new DrawTileCommand(referee, players, matchDriver, moves),
      PASS: new PassCommand(referee, matchDriver, moves),
      REVEAL_TILES: new RevealTilesCommand(referee, players, matchDriver),
      // LOS DOS DEL AUMENTO reciben el conductor de RONDA y no el de partida, que es la
      // diferencia de fondo con los otros cinco: congelar y descongelar mueve la fase de la
      // MANO, no la de la mesa. Y reciben el juez del aumento aparte del `Referee` general
      // porque éste no es un juez del juego: no mira fichas, mira dinero.
      PROPOSE_BET_MULTIPLIER: new ProposeBetMultiplierCommand(betReferee, bet, roundDriver),
      RESPOND_BET_MULTIPLIER: new RespondBetMultiplierCommand(betReferee, bet, roundDriver, match),
      // LOS DOS DE LA REVANCHA reciben el conductor de PARTIDA, al revés que los del aumento:
      // lo que mueven es la fase de la MESA y no la de la mano. Su juez tampoco lleva config —
      // las reglas de la revancha no miran un solo número de la mesa.
      REQUEST_REMATCH: new RequestRematchCommand(rematchReferee, matchDriver),
      RESPOND_REMATCH: new RespondRematchCommand(rematchReferee, matchDriver),
    },
  };
}
