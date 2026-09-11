import type { MatchEvent } from "../events.js";
import type { PlayerId } from "../ids.js";

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
