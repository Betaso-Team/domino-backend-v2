import type { PlayerId } from "../../ids";
import { rematchRespondersOf } from "../../rules/rematch";
import type { MatchState } from "../../state";
import { RematchState } from "../../state/rematch";

// EL DUEÑO DEL DATO de la revancha: quién pidió, quiénes aceptaron y si el botón se puede
// apretar. **No decide transiciones ni arma plazos** —eso es del conductor de PARTIDA, que es el
// dueño de la máquina de fases— y no juzga nada —eso es de `rules/rematch.ts`—.
//
// Es el gemelo de `BetNegotiation` y por el mismo motivo: las cuatro puntas de esta negociación
// son actos de jugador, y el vencimiento ya tiene quién lo conduzca.

export class RematchNegotiation {
  constructor(private readonly match: MatchState) {}

  /**
   * ABRE LA VENTANA, con el botón apagado o encendido según lo que la red haya contestado.
   *
   * El nodo nace acá y no en la génesis: su ausencia es "no hay revancha en juego", que es lo
   * que vale durante toda la partida.
   */
  open(eligible: boolean): void {
    const rematch = new RematchState();
    rematch.eligible = eligible;
    this.match.rematch = rematch;
  }

  /**
   * ALGUIEN PIDIÓ. Deja anotado quién, y a quién le toca contestar cuando es uno solo.
   *
   * `responderId` queda en `""` con más de un respondedor, que es la convención de v1: el front
   * usa `acceptedIds` para el 4P y este campo para el caso de dos, que es el único donde la
   * pregunta "¿a quién espero?" tiene una sola respuesta.
   */
  request(requesterId: PlayerId): void {
    const rematch = this.rematch();
    if (!rematch) return;
    const responders = rematchRespondersOf(requesterId, this.match);
    rematch.requesterId = requesterId;
    rematch.responderId = responders.length === 1 ? (responders[0] ?? "") : "";
    rematch.acceptedIds.splice(0, rematch.acceptedIds.length);
  }

  /**
   * ANOTA UNA ACEPTACIÓN.
   *
   * @returns si con ésta ya aceptaron TODOS los que tenían que aceptar. Se devuelve en vez de
   * dejar que el conductor lo recalcule porque el cálculo necesita la lista de respondedores, y
   * tenerla en dos lados es la forma de que una revancha de cuatro arranque con tres.
   */
  accept(playerId: PlayerId): boolean {
    const rematch = this.rematch();
    if (!rematch) return false;
    if (!rematch.acceptedIds.some((id) => id === playerId)) rematch.acceptedIds.push(playerId);
    const responders = rematchRespondersOf(rematch.requesterId, this.match);
    // `every` sobre la lista VIVA de respondedores y no sobre una foto: entre la solicitud y la
    // última respuesta alguien puede haberse retirado, y esperar su aceptación dejaría la mesa
    // colgada hasta que venza el plazo.
    return responders.every((id) => rematch.acceptedIds.some((accepted) => accepted === id));
  }

  /**
   * CIERRA LA NEGOCIACIÓN, con o sin trato, y borra el nodo entero. Los dos caminos borran, y
   * ése es el punto de que sea UNA sola operación: un nodo que sobrevive a su desenlace es una
   * revancha que se puede aceptar dos veces.
   *
   * Idempotente: el plazo puede vencer en el mismo tick en que entra la respuesta, y el segundo
   * en llegar no debe deshacer nada.
   */
  close(): void {
    this.match.rematch = undefined;
  }

  /** Quiénes faltan responder. Lo usa el conductor para saber si queda alguien de quien esperar. */
  pendingResponders(): readonly PlayerId[] {
    const rematch = this.rematch();
    if (!rematch) return [];
    return rematchRespondersOf(rematch.requesterId, this.match).filter(
      (id) => !rematch.acceptedIds.some((accepted) => accepted === id),
    );
  }

  private rematch(): RematchState | undefined {
    return this.match.rematch;
  }
}
