import type { MatchEvent } from "../core/events";
import type { PlayerId } from "../core/ids";

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
  | { type: "MATCH_ABORTED"; reason: AbortReason }
  // LOS DOS VETOS, y son de PLATAFORMA y no del juego: el motor no sabe que existe una cosa
  // llamada colusión, y ninguna regla del dominó consulta a quién se puede volver a cruzar.
  //
  // Son DOS eventos y no uno con un campo, porque son dos reglas distintas con dos alcances
  // distintos: el casual veta por REPETIR (la partida ya era la revancha) y vale para todo el
  // ámbito casual; el de torneo veta por BAJA CALIDAD y vale sólo dentro de ese torneo, que por
  // eso viaja en el evento. Juntarlos escondería la segunda diferencia adentro de un `if`.
  //
  // Los EMITE `network/veto.ts` y los ESCRIBE matchmaking (`matchmakingSink`). Que el que los
  // produce no conozca el libro es lo que impide que una partida decida a quién empareja el
  // lobby.
  | { type: "CASUAL_PAIR_VETOED"; playerIds: readonly PlayerId[] }
  | { type: "PAIR_VETOED"; tournamentId: string; playerIds: readonly PlayerId[] };

// Ensanche por INCLUSIÓN desde arriba: un MatchEvent YA ES un NetworkMatchEvent,
// así que la covarianza es segura e implícita y no hay traducción.
export type NetworkMatchEvent = MatchEvent | PlatformMatchEvent;
