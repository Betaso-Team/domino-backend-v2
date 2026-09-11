import type { MatchEvent } from "../core/events.js";
import type { PlayerId } from "../core/ids.js";

// Lo que solo la SALA sabe: que un socket se cayó, que volvió, y que esta partida
// se murió sin veredicto. El dominio no tiene un final sin veredicto.
//
// Los tres motivos son tres momentos distintos, y la diferencia es plata: los tres
// reembolsan, pero soporte tiene que poder decir CUÁL fue.
//   · NEVER_STARTED — la mesa nunca se llenó (venció el plazo de ocupación).
//   · NEVER_PLAYED  — se llenó y se repartió, pero NADIE levantó sus fichas: venció la
//                     ventana de reparto con los dos ausentes (reglas §3.1). Es el
//                     hermano tardío del anterior: allá nunca se llenó, acá nunca arrancó.
//   · INTERRUPTED   — se estaba jugando y la sala se murió sin veredicto.
export type AbortReason = "NEVER_STARTED" | "NEVER_PLAYED" | "INTERRUPTED";

export type PlatformMatchEvent =
  | { type: "PLAYER_DISCONNECTED"; playerId: PlayerId }
  | { type: "PLAYER_RECONNECTED"; playerId: PlayerId }
  | { type: "MATCH_ABORTED"; reason: AbortReason };

// Ensanche por INCLUSIÓN desde arriba: un MatchEvent YA ES un NetworkMatchEvent,
// así que la covarianza es segura e implícita y no hay traducción.
export type NetworkMatchEvent = MatchEvent | PlatformMatchEvent;
