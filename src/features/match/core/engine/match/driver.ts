import type { GlobalDominoConfig } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import type { Clock } from "../clock.js";
import { deadlineKindOf } from "../deadline-kind.js";
import type { Driver, RoundAction, TransitionResult } from "../driver.js";
import { InvariantViolationError } from "../errors.js";
import type { TimeoutScheduler } from "../timeout-scheduler.js";
import type { MatchReferee } from "./referee.js";

// CONDUCTOR de la PARTIDA. Dueño de las transiciones de fase y de los plazos.
// Su superficie pública son begin/advance/timeout y nada más.
export class MatchDriver implements Driver {
  constructor(
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly scheduler: TimeoutScheduler,
    private readonly config: GlobalDominoConfig,
    private readonly referee: MatchReferee,
  ) {}

  // IDEMPOTENTE: la sala lo llama en cada conexión, y una reconexión vuelve a
  // completar la mesa. Arrancar dos veces no puede repartir de nuevo.
  begin(): void {
    if (this.match.phase !== "NOT_STARTED") return;
    this.match.phase = "PLAYING";
    this.match.startedAt = this.clock.now();
    // La reserva de tiempo extra empieza a existir cuando la partida empieza. Es el
    // único lugar que la siembra: de acá en adelante SOLO decrece (reglas §5.1,
    // decisión 7). La génesis no puede hacerlo porque no recibe el config global.
    for (const player of this.match.players) {
      player.extraTimeRemainingMs = this.config.extraTimeReserveMs;
    }
  }

  advance(_actorId: PlayerId, _action: RoundAction): TransitionResult {
    if (this.match.phase !== "PLAYING") return { events: [], finished: false };
    if (this.referee.outcome()) {
      return { events: this.enterPresentingMatch(), finished: false };
    }
    return { events: [], finished: false };
  }

  timeout(): TransitionResult {
    const kind = deadlineKindOf(this.match);
    const events: MatchEvent[] = [{ type: "DEADLINE_EXPIRED", kind }];

    // La presentación terminó. El VEREDICTO ya salió al ENTRAR a esta fase, así que
    // acá no se dictamina nada: solo se cierra la máquina. Ver `enterPresentingMatch`.
    if (kind === "PRESENTING_MATCH") {
      this.match.phase = "FINISHED";
      this.match.activeDeadline = 0;
      this.scheduler.cancel();
      return { events, finished: true };
    }

    throw new InvariantViolationError(`el conductor de PARTIDA no maneja ${kind}`);
  }

  // `MATCH_RESOLVED` sale al ENTRAR a la presentación, NO al vencerla.
  //
  // Es la corrección que truco documentó en su changelog de revancha (negocio v26 §2):
  // con el evento al vencer, el premio esperaba toda la pausa —y con las fases de
  // revancha del otro lado, hasta 40 segundos—. La regla de producto es la contraria:
  // en lo que finaliza una partida se paga al ganador, haya revancha o no. El listener
  // que paga cuelga de este evento, así que de dónde se emite ES la latencia del pago.
  //
  // Consecuencia que hay que ver antes de escribirla: cualquier guarda de reembolso en
  // `onDispose` NO puede comparar contra la fase terminal, porque con fases después del
  // veredicto reembolsaría una partida ya pagada. Se pregunta por el veredicto
  // (`referee.outcome()`), no por `phase === "FINISHED"`.
  private enterPresentingMatch(): readonly MatchEvent[] {
    const outcome = this.referee.outcome();
    if (!outcome) throw new InvariantViolationError("presentación de partida sin veredicto");
    this.match.phase = "PRESENTING_MATCH";
    this.stampDeadline(this.config.presentingMatchMs);
    return [{ type: "MATCH_RESOLVED", ...outcome }];
  }

  // Estampa el instante en el estado Y arma el timer por el puerto. Las dos cosas
  // juntas, siempre: el estado dice CUÁNDO vence y el puerto lo hace ocurrir.
  private stampDeadline(durationMs: number): void {
    const at = this.clock.now() + durationMs;
    this.match.activeDeadline = at;
    this.scheduler.schedule(at, () => this.timeout().events);
  }
}
