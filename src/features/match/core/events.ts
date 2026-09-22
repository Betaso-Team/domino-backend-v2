import type { PlayerId, TeamId } from "./ids";

// A qué ventana sirve el único plazo del juego. Un solo campo en el estado
// ⇒ un solo evento de vencimiento y un solo eje que lo discrimine.
//
// `DEALING` es la ventana de reparto (reglas §3.1). Es de nivel RONDA como el turno, pero
// a diferencia del turno **no es de nadie en particular**: corre para todos a la vez, y
// eso es exactamente para lo que existe —el reloj del turno solo mira al que le toca—.
// `NEGOTIATING_BET` es la ventana de respuesta del aumento de apuesta, y es de nivel RONDA
// como las otras dos: la oferta muere con la ronda en la que se hizo.
// Las TRES de la revancha son de nivel PARTIDA, y son tres porque esperan cosas distintas: que
// alguien pida, que los demás contesten, y que el cliente alcance a consumir su reserva antes de
// que la sala vieja se suelte. Distinguirlas importa para el REGISTRO además de para el
// despacho: «nadie pidió» y «pidió uno y el otro no contestó» son dos finales distintos, y el
// que audita una mesa quiere saber cuál fue.
export type DeadlineKind =
  | "DEALING"
  | "TURN"
  | "NEGOTIATING_BET"
  | "PRESENTING_ROUND"
  | "PRESENTING_MATCH"
  | "REMATCH_WINDOW"
  | "REMATCH_NEGOTIATION"
  | "REMATCH_ACCEPTED";

// EL CRITERIO (spec §5.1): un evento existe SOLO si ocurre un hecho que no se puede
// reconstruir del comando ni del estado resultante. Si el payload del evento solo
// repetiría el del comando, no es un evento.
//
// Por eso PLAY_TILE y PASS dichos por el JUGADOR no están acá: el comando ya es el
// registro. Los mismos verbos SÍ aparecen cuando los dice el SISTEMA por quien calló,
// porque ahí no hay comando que los cuente. El evento existe ⟺ no hubo comando detrás.
export type MatchEvent =
  // ── Consecuencias computadas ────────────────────────────────────────────
  | {
      type: "ROUND_RESOLVED";
      roundNumber: number;
      winnerId: PlayerId;
      winnerTeamId: TeamId | "";
      points: number;
      reason: "DOMINO" | "BLOCKED";
    }
  // ── Lo que el SISTEMA hizo ──────────────────────────────────────────────
  | { type: "DEADLINE_EXPIRED"; kind: DeadlineKind }
  // Retirado POR TIMEOUT, nunca por el verbo voluntario. Es el caso canónico de
  // "el evento existe ⟺ no hubo comando detrás": el ABANDON voluntario ya quedó
  // registrado como comando, así que emitirlo encima sería la transcripción 1:1
  // que el criterio prohíbe. Éste, en cambio, no lo pidió nadie — y para soporte
  // es toda la diferencia entre "se fue" y "lo sacaron".
  | { type: "ABANDON"; playerId: PlayerId }
  // El aumento RECHAZADO POR EL RELOJ, nunca por el verbo voluntario — mismo criterio que
  // `ABANDON`: el "no" dicho a mano ya quedó registrado como comando, y emitirlo encima
  // sería la transcripción 1:1 que el criterio prohíbe. Éste no lo dijo nadie: la mesa
  // estaba congelada esperando una respuesta que no llegó, y alguien tenía que darla.
  //
  // El `playerId` es el del que CALLÓ, que es la información que no está en ningún otro
  // lado: la oferta se borra al resolverse, así que sin esto no queda rastro de quién dejó
  // correr el reloj. Para soporte es la diferencia entre "dijo que no" y "no contestó".
  | { type: "BET_MULTIPLIER_REJECTED"; playerId: PlayerId }
  // ── Hitos terminales ────────────────────────────────────────────────────
  | { type: "MATCH_RESOLVED"; winnerTeamId: TeamId; reason: "SCORE" | "ABANDONMENT" }
  // TODOS ACEPTARON LA REVANCHA. Es una CONSECUENCIA COMPUTADA y no el eco de un comando, que
  // es lo que lo deja pasar el criterio: el último `RESPOND_REMATCH` dice «yo acepto», y lo que
  // este evento dice es «ya no falta nadie» — que depende de quiénes seguían en la mesa en ese
  // instante y no está en el payload de ningún comando. Es el gemelo de `ROUND_RESOLVED`.
  //
  // Es además la señal que la RED espera para abrir la mesa nueva, y por eso lleva la lista:
  // el nodo se borra al cerrar la negociación, así que para cuando alguien reaccione ya no
  // estaría. Quien abre la sala necesita saber a quiénes sentar.
  | { type: "REMATCH_ACCEPTED"; playerIds: readonly PlayerId[] };
