import type { MatchEvent } from "../events";
import type { PlayerId } from "../ids";

export interface TransitionResult {
  readonly events: readonly MatchEvent[];
  // Overloaded a propósito según qué conductor lo devuelve: para el conductor de RONDA
  // significa "esta ronda se resolvió"; para el conductor de PARTIDA significa "la
  // partida llegó a su fase terminal". Mismo nombre, distinta granularidad según qué
  // conductor lo tengas en la mano.
  readonly finished: boolean;
}

// QUÉ hizo el actor. El conductor lo necesita porque las acciones reconcilian
// distinto: jugar puede cerrar la mano por dominó y pasa el turno; robar conserva
// el turno pero reinicia el plazo (reglas §7 decisión 4); pasar puede destapar una
// tranca. `ABANDONED` reconcilia igual que `PASSED` —el que se va tiene fichas, así
// que no cierra por dominó— pero se nombra aparte para que el conductor no tenga
// que mentir sobre qué pasó.
// `REVEALED` no es una jugada: es la salida de la ventana de reparto (reglas §3.1). Está
// en la misma unión porque entra por el mismo `advance`, pero se reconcilia ANTES que
// todo lo demás y no llega a la guarda de `PLAYING` —es la única fase, además de esa, en
// la que un verbo de jugador es legal—.
// EL AUMENTO DE APUESTA NO ESTÁ EN ESTA UNIÓN, y es deliberado: `advance` es "alguien actuó
// en la mano, reconciliá", y congelar o descongelar la ronda no reconcilia nada —no hay ficha
// que mirar, ni mano que pueda cerrarse—. Entra por métodos propios del conductor de RONDA
// (`freezeForBet` / `resumeFromBet`), como ya lo hace la ventana de reparto con
// `resumeAfterDealWindow`.
export type RoundAction = "PLAYED" | "DREW" | "PASSED" | "ABANDONED" | "REVEALED";

// La superficie pública de un conductor son estos tres verbos y nada más.
// `advance` recibe QUIÉN actuó y QUÉ hizo: sin lo primero no puede saber si el
// actor sigue en la mano, y sin lo segundo tendría que adivinar la reconciliación
// comparando el estado contra sí mismo.
export interface Driver {
  begin(): void;
  advance(actorId: PlayerId, action: RoundAction): TransitionResult;
  timeout(): TransitionResult;
}

/**
 * SE VA ALGUIEN, y alguien tiene que decidir qué queda: la mesa sigue con una máquina en ese
 * asiento, o la partida se cierra por abandono.
 *
 * **ES UNA INTERFAZ APARTE Y NO UN CUARTO VERBO DE `Driver`**, porque retirarse es de nivel
 * PARTIDA: el conductor de RONDA también implementa `Driver` y no tiene nada que decir acá —una
 * mano no decide si la mesa sigue existiendo—. Metido ahí, tendría que implementarlo para lanzar.
 *
 * `bySystem` distingue quién lo pidió, y sólo cambia una cosa: el evento `ABANDON`. El verbo
 * voluntario ya quedó registrado como comando y emitirlo encima sería la transcripción 1:1 que el
 * criterio de eventos prohíbe; el retiro por reloj no lo pidió nadie.
 */
export interface Retirement {
  retire(playerId: PlayerId, bySystem: boolean): TransitionResult;
}
