import type { GlobalDominoConfig } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import type { Clock } from "../clock.js";
import { deadlineKindOf } from "../deadline-kind.js";
import type { Driver, RoundAction, TransitionResult } from "../driver.js";
import { InvariantViolationError } from "../errors.js";
import type { Player } from "../player-facade.js";
import type { RoundDriver } from "../round/driver.js";
import { matchPhaseOf, roundActivePlayers } from "../state-projections.js";
import type { TimeoutScheduler } from "../timeout-scheduler.js";
import type { MatchReferee } from "./referee.js";

export class MatchDriver implements Driver {
  constructor(
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly scheduler: TimeoutScheduler,
    private readonly config: GlobalDominoConfig,
    private readonly referee: MatchReferee,
    private readonly players: Player,
    private readonly roundDriver: RoundDriver,
  ) {}

  begin(): void {
    if (matchPhaseOf(this.match) !== "NOT_STARTED") return;
    this.match.phase = "PLAYING";
    this.match.startedAt = this.clock.now();
    for (const player of this.match.players) {
      player.extraTimeRemainingMs = this.config.extraTimeReserveMs;
    }
    this.roundDriver.begin();
    this.syncTimeout();
  }

  advance(actorId: PlayerId, action: RoundAction): TransitionResult {
    if (matchPhaseOf(this.match) !== "PLAYING") return { events: [], finished: false };
    const transition = this.referee.outcome()
      ? { events: this.enterPresentingMatch(), finished: false }
      : this.roundDriver.advance(actorId, action);
    this.syncTimeout();
    return transition;
  }

  timeout(): TransitionResult {
    const kind = deadlineKindOf(this.match);
    const events: MatchEvent[] = [{ type: "DEADLINE_EXPIRED", kind }];

    if (kind === "DEALING") {
      const missing = this.roundDriver.playersMissingTiles();
      for (const playerId of missing) this.players.abandon(playerId);
      events.push(...missing.map((playerId) => ({ type: "ABANDON", playerId }) as const));

      if (roundActivePlayers(this.match).length === 0) {
        this.match.activeDeadline = 0;
        this.syncTimeout();
        return { events, finished: false };
      }
      if (this.referee.outcome()) {
        const transition = { events: [...events, ...this.enterPresentingMatch()], finished: false };
        this.syncTimeout();
        return transition;
      }
      this.roundDriver.resumeAfterDealWindow();
      this.syncTimeout();
      return { events, finished: false };
    }

    if (kind === "TURN") {
      const playerId = this.roundDriver.currentTurnPlayerId();
      if (this.roundDriver.extendWithReserve(playerId)) {
        this.syncTimeout();
        return { events, finished: false };
      }
      this.players.abandon(playerId);
      events.push({ type: "ABANDON", playerId });
      const transition = this.advance(playerId, "ABANDONED");
      return { events: [...events, ...transition.events], finished: transition.finished };
    }

    // EL AUMENTO SIN CONTESTAR. Se delega entero al conductor de RONDA —la negociación es de
    // la mano— y a diferencia del turno vencido NO retira a nadie: callarse ante una oferta
    // de plata es una respuesta legítima, y la más barata. Lo único que hace falta acá es
    // volver a programar el reloj, porque la ronda quedó corriendo con el plazo del turno que
    // el conductor de ronda le devolvió.
    if (kind === "NEGOTIATING_BET") {
      const inner = this.roundDriver.timeout();
      this.syncTimeout();
      return { events: [...events, ...inner.events], finished: false };
    }

    if (kind === "PRESENTING_ROUND") {
      const inner = this.roundDriver.timeout();
      const transition = {
        events: [...events, ...inner.events, ...this.afterRound()],
        finished: false,
      };
      this.syncTimeout();
      return transition;
    }

    if (kind === "PRESENTING_MATCH") {
      this.match.phase = "FINISHED";
      this.match.activeDeadline = 0;
      this.syncTimeout();
      return { events, finished: true };
    }

    throw new InvariantViolationError(`el conductor de PARTIDA no maneja ${kind}`);
  }

  private afterRound(): readonly MatchEvent[] {
    if (this.referee.outcome()) return this.enterPresentingMatch();
    this.roundDriver.begin();
    return [];
  }

  private enterPresentingMatch(): readonly MatchEvent[] {
    const outcome = this.referee.outcome();
    if (!outcome) throw new InvariantViolationError("presentación de partida sin veredicto");
    this.match.phase = "PRESENTING_MATCH";
    this.stampDeadline(this.config.presentingMatchMs);
    return [{ type: "MATCH_RESOLVED", ...outcome }];
  }

  private stampDeadline(durationMs: number): void {
    this.match.activeDeadline = this.clock.now() + durationMs;
  }

  private syncTimeout(): void {
    const at = this.match.activeDeadline;
    if (at > 0) this.scheduler.schedule(at, () => this.timeout().events);
    else this.scheduler.cancel();
  }
}
