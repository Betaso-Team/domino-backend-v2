import type { DominoMatchConfig, GlobalDominoConfig } from "../../config";
import type { MatchEvent } from "../../events";
import type { PlayerId } from "../../ids";
import { canSeatBot } from "../../rules/bot";
import { isTableIntact } from "../../rules/rematch";
import type { MatchState } from "../../state";
import { SchemaMatchView } from "../../state/view";
import type { Clock } from "../clock";
import { deadlineKindOf } from "../deadline-kind";
import type { Driver, Retirement, RoundAction, TransitionResult } from "../driver";
import { InvariantViolationError } from "../errors";
import type { Player } from "../player-facade";
import type { RematchGate } from "../rematch/gate";
import type { RematchNegotiation } from "../rematch/negotiation";
import type { RoundDriver } from "../round/driver";
import { matchPhaseOf, roundActivePlayers } from "../state-projections";
import type { TimeoutScheduler } from "../timeout-scheduler";
import type { MatchReferee } from "./referee";

export class MatchDriver implements Driver, Retirement {
  constructor(
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly scheduler: TimeoutScheduler,
    private readonly config: GlobalDominoConfig,
    private readonly referee: MatchReferee,
    private readonly players: Player,
    private readonly roundDriver: RoundDriver,
    // LOS DOS DE LA REVANCHA. La compuerta la escribe la RED durante la pausa de presentación y
    // este conductor solo la lee; la negociación es el dueño del nodo y no mueve fases. Las
    // transiciones —abrir, negociar, aceptar, cerrar— son de acá, que es el dueño de la máquina.
    private readonly gate: RematchGate,
    private readonly rematch: RematchNegotiation,
    // EL SNAPSHOT DE LA MESA, y lo único que este conductor le pregunta es si reemplaza con una
    // máquina al que se va. Entra entero y no como un booleano suelto porque la guarda vive en
    // `rules/` y pide la config de reglas, que este tipo satisface por estructura.
    private readonly matchConfig: DominoMatchConfig,
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
      const transition = this.retire(playerId, true);
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

    // LA PAUSA DE PRESENTACIÓN SE ACABÓ, y acá se decide si la mesa muere o se abre la ventana.
    //
    // ⚠ LA VENTANA SE ABRE AUNQUE NO SEAN ELEGIBLES, y ahí este repo sigue a v1 y no a truco.
    // Allá, sin elegibilidad no hay ventana —«que nadie vea un botón que no puede usar»—; acá se
    // abre con `eligible: false` y el front pinta el botón apagado. La diferencia importa porque
    // las dos cosas que el jugador necesita saber son distintas: «no te alcanza» se arregla
    // poniendo saldo, y no mostrar nada se lee como que la revancha no existe.
    //
    // Lo que NO abre ventana es una mesa que no ofrece revancha —hoy, el torneo—: ahí sí sería
    // un botón gris mintiendo sobre el motivo, y por eso son DOS preguntas a la compuerta.
    if (kind === "PRESENTING_MATCH") {
      // DOS MOTIVOS PARA NO ABRIRLA, y son distintos. Que la mesa no la OFREZCA es del modo
      // —un torneo—. Que la mesa no esté ENTERA es de esta partida: alguien se retiró, así que
      // no hay con quién volver a jugar y no hay nada que el que quedó pueda arreglar. Los dos
      // terminan igual y por eso van juntos; abrir apagado en cualquiera de los dos casos sería
      // treinta segundos mirando un botón gris.
      if (!this.gate.offersRematch() || !isTableIntact(this.match)) return this.finish(events);
      this.rematch.open(this.gate.isAllowed());
      this.match.phase = "REMATCH_WINDOW";
      this.stampDeadline(this.config.rematchWindowMs);
      this.syncTimeout();
      return { events, finished: false };
    }

    // LAS TRES DE LA REVANCHA TERMINAN IGUAL Y POR ESO VAN JUNTAS: nadie pidió, nadie contestó, o
    // el traspaso ya dio tiempo de sobra. En los tres casos no queda nada que hacer en ESTA mesa.
    //
    // Que el desenlace sea el mismo no las vuelve el mismo caso: el `DEADLINE_EXPIRED` que ya se
    // emitió arriba lleva cuál venció, y para el que audita una mesa «nadie pidió» y «pidió uno y
    // el otro no contestó» son dos historias distintas.
    if (
      kind === "REMATCH_WINDOW" ||
      kind === "REMATCH_NEGOTIATION" ||
      kind === "REMATCH_ACCEPTED"
    ) {
      return this.finish(events);
    }

    throw new InvariantViolationError(`el conductor de PARTIDA no maneja ${kind}`);
  }

  /**
   * SE VA ALGUIEN, Y ACÁ SE DECIDE SI LA MESA SIGUE. Es el único lugar donde eso se decide, y
   * tiene que serlo: los dos caminos que retiran a un asiento —el verbo `ABANDON` y el reloj del
   * turno— llegan acá, así que la mesa no puede comportarse distinto según por cuál entró.
   *
   * **SENTAR EL BOT NO RECONCILIA NADA**, y es la diferencia de fondo con el abandono. El asiento
   * sigue en la rueda con sus fichas, así que no hay mano que pueda haberse cerrado ni tranca que
   * destapar: no se llama a `advance`. Lo único que hace falta es devolverle el reloj, porque por
   * el camino del timeout el turno que hereda viene vencido — sin eso el bot tiene un turno de
   * duración cero y el siguiente vencimiento lo retira de nuevo, esta vez de verdad.
   */
  retire(playerId: PlayerId, bySystem: boolean): TransitionResult {
    if (canSeatBot(playerId, new SchemaMatchView(this.match), this.matchConfig)) {
      this.players.seatBot(playerId);
      this.roundDriver.restartTurnIfOwnedBy(playerId);
      this.syncTimeout();
      return { events: [{ type: "BOT_SEATED", playerId }], finished: false };
    }

    this.players.abandon(playerId);
    const events: MatchEvent[] = bySystem ? [{ type: "ABANDON", playerId }] : [];
    const transition = this.advance(playerId, "ABANDONED");
    return { events: [...events, ...transition.events], finished: transition.finished };
  }

  /**
   * ALGUIEN PIDIÓ LA REVANCHA. La legalidad ya la juzgó el comando; acá solo se mueve la mesa.
   *
   * ⚠ EL MISMO VERBO DURANTE LA NEGOCIACIÓN ES UNA ACEPTACIÓN, y es el doble sentido que
   * `rules/rematch.ts` deja pasar a propósito: con los dos apretando «Revancha» en el mismo
   * segundo —que es lo que pasa cuando los dos la quieren— tratar al segundo como un error
   * mataría la revancha que ambos querían. Es la regla de v1, contra la de truco, que lo declara
   * ilegal. Se rutea acá y no en el comando porque es una TRANSICIÓN, no una legalidad.
   */
  requestRematch(playerId: PlayerId): TransitionResult {
    if (matchPhaseOf(this.match) === "REMATCH_NEGOTIATION")
      return this.respondRematch(playerId, true);
    if (matchPhaseOf(this.match) !== "REMATCH_WINDOW") return { events: [], finished: false };
    this.rematch.request(playerId);
    this.match.phase = "REMATCH_NEGOTIATION";
    this.stampDeadline(this.config.rematchResponseMs);
    this.syncTimeout();
    return { events: [], finished: false };
  }

  /**
   * UNO CONTESTÓ. Declinar cierra para TODA la mesa —basta uno— y aceptar solo cuenta: la mesa
   * nueva se abre cuando no falta nadie.
   */
  respondRematch(playerId: PlayerId, accept: boolean): TransitionResult {
    if (matchPhaseOf(this.match) !== "REMATCH_NEGOTIATION") return { events: [], finished: false };
    if (!accept) return this.finish([]);

    const playerIds = this.match.players.map((player) => player.playerId);
    if (!this.rematch.accept(playerId)) {
      // Falta alguien. El plazo NO se re-estampa: es de la solicitud entera y no de cada
      // respuesta, o sea que tres jugadores contestando de a uno no pueden estirarlo a quince
      // segundos mientras el que pidió mira una pantalla quieta.
      return { events: [], finished: false };
    }

    // TODOS ACEPTARON. La mesa pasa al traspaso y la negociación se cierra: el nodo ya no tiene
    // nada que decir, y dejarlo vivo permitiría una segunda aceptación sobre una revancha hecha.
    this.rematch.close();
    this.match.phase = "REMATCH_ACCEPTED";
    this.stampDeadline(this.config.rematchHandoffMs);
    this.syncTimeout();
    // La lista viaja EN EL EVENTO porque el nodo que la tenía se acaba de borrar, y quien abre la
    // sala nueva —que reacciona a esto— necesita saber a quiénes sentar.
    return { events: [{ type: "REMATCH_ACCEPTED", playerIds }], finished: false };
  }

  /**
   * LA REVANCHA YA NO ES POSIBLE, y lo dice alguien de AFUERA: un socket que se cayó mientras se
   * negociaba, o la red avisando que la apertura de la sala falló.
   *
   * El motor no puede tomar esta decisión y no es un olvido: una desconexión es un hecho de
   * PLATAFORMA y el juego no los mira. Acá sí importan, por una razón concreta y chica — sin
   * esto, el que ofreció se queda mirando una cuenta atrás que ya no puede terminar en nada.
   *
   * Idempotente y sin efecto fuera de las fases de revancha, así que una desconexión en medio de
   * la partida pasa por acá sin consecuencia.
   */
  closeRematch(): TransitionResult {
    if (!isNegotiatingRematch(matchPhaseOf(this.match))) return { events: [], finished: false };
    return this.finish([]);
  }

  // EL ÚNICO TERMINAL, y por eso está escrito una vez: de la pausa de presentación y de las tres
  // fases de la revancha se sale al mismo lado. El nodo se borra siempre — también cuando la
  // ventana nunca llegó a abrirse, donde no hay nada que borrar y la llamada es inofensiva.
  private finish(events: MatchEvent[]): TransitionResult {
    this.rematch.close();
    this.match.phase = "FINISHED";
    this.match.activeDeadline = 0;
    this.syncTimeout();
    return { events, finished: true };
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

// Las dos fases en las que hay algo que cerrar. `REMATCH_ACCEPTED` NO está: ahí la sala nueva ya
// existe y cada uno tiene su reserva, así que cerrar sería quitarle la revancha a alguien que ya
// la tiene. Lo que queda ahí es esperar el traspaso, y de eso se ocupa el plazo.
function isNegotiatingRematch(phase: string): boolean {
  return phase === "REMATCH_WINDOW" || phase === "REMATCH_NEGOTIATION";
}
