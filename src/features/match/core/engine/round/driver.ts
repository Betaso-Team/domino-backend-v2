import type { DominoMatchConfig, GlobalDominoConfig } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { PlayerId } from "../../ids.js";
import { BoardState, BoneyardState, RoundState, Turn } from "../../state/index.js";
import type { MatchState } from "../../state/index.js";
import type { BetNegotiation } from "../bet/index.js";
import type { Clock } from "../clock.js";
import type { Dealer } from "../dealer.js";
import type { Driver, RoundAction, TransitionResult } from "../driver.js";
import { InvariantViolationError } from "../errors.js";
import type { RoundVerdict, Scorer } from "../scorer.js";
import {
  currentRoundOf,
  currentTurnOf,
  handOf,
  playerOf,
  roundActivePlayers,
  roundPhaseOf,
  teamOf,
  turnOrderFrom,
} from "../state-projections.js";
import { DOMINO_SET_SIZE, tileValue } from "../tile-set.js";
import { blockVerdictOf, isBlocked } from "./block.js";
import { firstPlayerOf } from "./first-turn.js";
import type { RoundPlayer } from "./player.js";
import type { RoundReferee } from "./referee.js";

export class RoundDriver implements Driver {
  constructor(
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly config: GlobalDominoConfig,
    private readonly matchConfig: DominoMatchConfig,
    private readonly referee: RoundReferee,
    private readonly dealer: Dealer,
    private readonly scorer: Scorer,
    private readonly playerAt: (playerId: PlayerId) => RoundPlayer,
    // El dueño del DATO del aumento. El conductor lo necesita solo para el camino del
    // reloj: cuando el plazo de la negociación vence, alguien tiene que cerrarla, y el que
    // conduce las fases es éste.
    private readonly bet: BetNegotiation,
  ) {}

  begin(): void {
    const previous = this.match.currentRound;
    const round = new RoundState();
    round.roundNumber = this.match.pastRounds.length + 1;
    round.board = new BoardState();
    round.currentTurn = new Turn();
    if (this.hasBoneyard()) round.boneyard = new BoneyardState();
    this.match.currentRound = round;

    this.hideAllHands();
    this.dealer.deal(round.roundNumber);
    round.starterId = previous?.starterId
      ? this.nextPlayerAfter(previous.starterId)
      : firstPlayerOf(
          roundActivePlayers(this.match).map((player) => ({
            playerId: player.playerId,
            tiles: [...player.hand.tiles],
          })),
        );

    if (this.matchConfig.isDealWindowEnabled && round.roundNumber === 1) {
      this.stampDeadline(this.config.dealingTimeoutMs);
      return;
    }
    this.revealAllHands();
    this.continueAfterDeal();
  }

  advance(actorId: PlayerId, action: RoundAction): TransitionResult {
    const round = currentRoundOf(this.match);
    if (roundPhaseOf(round) === "DEALING") {
      if (this.referee.playersWithoutTilesSeen().length === 0) this.continueAfterDeal();
      return { events: [], finished: false };
    }
    if (roundPhaseOf(round) !== "PLAYING") return { events: [], finished: false };
    this.settleExtraTime();

    if (action === "DREW") {
      this.startTurn(actorId);
      return { events: [], finished: false };
    }

    const turn = currentTurnOf(round);
    turn.consecutivePasses =
      action === "PASSED" || action === "ABANDONED" ? turn.consecutivePasses + 1 : 0;

    if (handOf(actorId, this.match).tiles.length === 0) {
      return this.closeRound({
        roundNumber: round.roundNumber,
        winnerId: actorId,
        points: this.opposingHandsValue(actorId),
        reason: "DOMINO",
      });
    }

    if (turn.consecutivePasses >= roundActivePlayers(this.match).length && isBlocked(this.match)) {
      const verdict = blockVerdictOf(this.match);
      return this.closeRound({
        roundNumber: round.roundNumber,
        winnerId: verdict.winnerId,
        points: verdict.points,
        reason: "BLOCKED",
      });
    }

    this.startTurn(this.nextPlayerAfter(actorId));
    return { events: [], finished: false };
  }

  timeout(): TransitionResult {
    const phase = roundPhaseOf(currentRoundOf(this.match));
    if (phase === "PRESENTING_ROUND") return { events: [], finished: true };
    // EL SILENCIO ES UN NO. La mesa está congelada esperando una respuesta, así que dejarla
    // esperar no puede ser gratis: el turno de otro quedaría rehén de una propuesta que nadie
    // contesta. Es la regla de v1 y es la única que puede ser, con el juego detenido.
    // EL SILENCIO ES UN NO. La mesa está congelada esperando una respuesta, así que dejarla
    // esperar no puede salir gratis: el turno de otro quedaría rehén de una propuesta que
    // nadie contesta. Es la regla de v1, y con el juego detenido es la única que puede ser.
    if (phase === "NEGOTIATING_BET") {
      // LOS DOS SE PREGUNTAN ANTES DE CERRAR: `settle` borra la oferta, y con ella el rastro
      // de quién tenía que contestar y de cuánto reloj había congelado.
      const silent = this.bet.pendingRespondent((proposerId) => this.nextPlayerAfter(proposerId));
      const remaining = this.bet.frozenTurnMs();
      this.bet.settle(false);
      this.resumeFromBet(remaining);
      // El rechazo por reloj SÍ es evento: es lo único de esta transición que no se puede
      // reconstruir de un comando, porque no hubo comando.
      const events: readonly MatchEvent[] = silent
        ? [{ type: "BET_MULTIPLIER_REJECTED", playerId: silent }]
        : [];
      return { events, finished: false };
    }
    throw new InvariantViolationError(`el conductor de RONDA no maneja la fase ${phase}`);
  }

  // CONGELA LA RONDA para que se conteste el aumento. El turno no se toca —sigue siendo de
  // quien era— y lo único que cambia es la fase y a qué sirve el plazo.
  //
  // Se llama DESPUÉS de que la oferta exista: es la oferta la que guarda el reloj congelado.
  freezeForBet(): void {
    const round = currentRoundOf(this.match);
    // Primero se le liquida al que estaba jugando la reserva que estuviera consumiendo: el
    // plazo que estamos por pisar era el suyo.
    this.settleExtraTime();
    if (round.betOffer) {
      round.betOffer.turnRemainingMs = Math.max(0, this.match.activeDeadline - this.clock.now());
    }
    round.phase = "NEGOTIATING_BET";
    this.stampDeadline(this.config.betResponseTimeoutMs);
  }

  // DESCONGELA, devolviendo el reloj donde estaba. El remanente entra POR PARÁMETRO y no se
  // lee de la oferta a propósito: para cuando esto corre, la oferta ya se cerró —cerrarla es
  // lo que impide contestarla dos veces— así que leerla acá devolvería siempre cero, y cero
  // acá es un turno entero regalado.
  resumeFromBet(turnRemainingMs: number): void {
    currentRoundOf(this.match).phase = "PLAYING";
    // Cero significa que el turno ya estaba vencido cuando entró la propuesta. Ahí se estampa
    // el plazo entero en vez de un turno imposible: el que no propuso no tiene por qué pagar
    // ese borde.
    this.stampDeadline(turnRemainingMs > 0 ? turnRemainingMs : this.config.turnTimeoutMs);
  }

  playersMissingTiles(): readonly PlayerId[] {
    return this.referee.playersWithoutTilesSeen();
  }

  resumeAfterDealWindow(): void {
    this.revealAllHands();
    this.continueAfterDeal();
  }

  currentTurnPlayerId(): PlayerId {
    return currentTurnOf(currentRoundOf(this.match)).playerId;
  }

  extendWithReserve(playerId: PlayerId): boolean {
    const player = playerOf(playerId, this.match);
    const remaining = player.extraTimeRemainingMs;
    if (remaining <= 0) return false;
    player.extraTimeRemainingMs = 0;
    currentTurnOf(currentRoundOf(this.match)).isConsumingExtendedTime = true;
    this.stampDeadline(remaining);
    return true;
  }

  private continueAfterDeal(): void {
    const round = currentRoundOf(this.match);
    round.phase = "PLAYING";
    this.startTurn(round.starterId);
  }

  private revealAllHands(): void {
    for (const player of this.match.players) this.playerAt(player.playerId).revealTiles();
  }

  private hideAllHands(): void {
    for (const player of this.match.players) this.playerAt(player.playerId).hideTiles();
  }

  private hasBoneyard(): boolean {
    return this.match.players.length * this.config.tilesPerPlayer < DOMINO_SET_SIZE;
  }

  private closeRound(verdict: RoundVerdict): TransitionResult {
    const round = currentRoundOf(this.match);
    for (const player of this.match.players) {
      this.playerAt(player.playerId).revealTilesToAll();
    }
    this.scorer.credit(verdict);
    round.phase = "PRESENTING_ROUND";
    this.stampDeadline(this.config.presentingRoundMs);
    const event: MatchEvent = {
      type: "ROUND_RESOLVED",
      roundNumber: verdict.roundNumber,
      winnerId: verdict.winnerId ?? "",
      winnerTeamId: verdict.winnerId ? teamOf(verdict.winnerId, this.match) : "",
      points: verdict.points,
      reason: verdict.reason,
    };
    return { events: [event], finished: false };
  }

  private opposingHandsValue(winnerId: PlayerId): number {
    return roundActivePlayers(this.match)
      .filter((player) => player.playerId !== winnerId)
      .reduce(
        (sum, player) =>
          sum + [...player.hand.tiles].reduce((inner, tile) => inner + tileValue(tile), 0),
        0,
      );
  }

  private nextPlayerAfter(playerId: PlayerId): PlayerId {
    const order = turnOrderFrom(playerId, this.match).filter((player) => !player.hasAbandoned);
    return (order[1] ?? order[0])?.playerId ?? playerId;
  }

  private startTurn(playerId: PlayerId): void {
    const turn = currentTurnOf(currentRoundOf(this.match));
    turn.playerId = playerId;
    turn.isConsumingExtendedTime = false;
    this.stampDeadline(this.config.turnTimeoutMs);
  }

  private settleExtraTime(): void {
    const turn = currentTurnOf(currentRoundOf(this.match));
    if (!turn.isConsumingExtendedTime || !turn.playerId) return;
    const unused = this.match.activeDeadline - this.clock.now();
    playerOf(turn.playerId, this.match).extraTimeRemainingMs = Math.max(0, unused);
  }

  private stampDeadline(durationMs: number): void {
    this.match.activeDeadline = this.clock.now() + durationMs;
  }
}
