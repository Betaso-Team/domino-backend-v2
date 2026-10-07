import type { MatchEvent } from "../core/events";
import type { PlayerId } from "../core/ids";

// Lo que solo la SALA sabe: que un socket se cayó, que volvió, y que esta partida
// se murió sin veredicto. El dominio no tiene un final sin veredicto.
//
// Los cuatro motivos son cuatro momentos distintos, y la diferencia es plata: los cuatro
// reembolsan, pero soporte tiene que poder decir CUÁL fue.
//   · NEVER_STARTED  — la mesa nunca se llenó (venció el plazo de ocupación).
//   · TILES_NOT_SEEN — alguien se fue —por su cuenta o retirado por el reloj— con la ventana de
//                      reparto abierta, y el JUEGO anuló la partida (`wasAbortedAtDeal`, reglas
//                      §3.1). Es el único final sin veredicto que decide el juego y no la sala, y
//                      el único que no le devuelve a todos: el que se fue habiendo levantado sus
//                      fichas pierde la inscripción (`isRefundable`), como en v1.
//   · NEVER_PLAYED   — se llenó y se repartió, nadie levantó sus fichas ni se fue, y la SALA se
//                      murió en la ventana. El hermano tardío de NEVER_STARTED.
//   · INTERRUPTED    — se estaba jugando y la sala se murió sin veredicto.
export type AbortReason = "NEVER_STARTED" | "TILES_NOT_SEEN" | "NEVER_PLAYED" | "INTERRUPTED";

export type PlatformMatchEvent =
  | { type: "PLAYER_DISCONNECTED"; playerId: PlayerId }
  | { type: "PLAYER_RECONNECTED"; playerId: PlayerId }
  | { type: "MATCH_ABORTED"; reason: AbortReason };

// Ensanche por INCLUSIÓN desde arriba: un MatchEvent YA ES un NetworkMatchEvent,
// así que la covarianza es segura e implícita y no hay traducción.
export type NetworkMatchEvent = MatchEvent | PlatformMatchEvent;
