// EL VOCABULARIO DE LA PARTIDA, y ya NO vive adentro del schema.
//
// Estas tres uniones estaban declaradas junto a los nodos que las guardan, y ahí describían el
// ÁRBOL. Pero son del JUEGO: "es tu turno" es una afirmación sobre la fase, no sobre un campo
// `t.string()`, y una regla que el cliente corra necesita las palabras sin necesitar el schema
// que las almacena. `state/match.ts` y `state/round.ts` las re-exportan, así que la mudanza no
// le cambió el import a nadie.
//
// Es el mismo movimiento que hizo truco (`528ff7a`), y por el mismo motivo: el schema es CÓMO se
// guarda y se sincroniza; las palabras son QUÉ pasa en la mesa.

// DOS PALABRAS, DOS HECHOS (truco negocio v26, changelog "Revancha" §3). `RESOLVED` es el
// VEREDICTO —el juego dictaminó— y por eso vive SOLO en eventos (`ROUND_RESOLVED`,
// `MATCH_RESOLVED`); `FINISHED` es el terminal de ESTA MÁQUINA —no queda nada por hacer en
// esta mesa— y por eso vive SOLO en fases. Coinciden mientras la partida se apaga al
// dictaminarse; la REVANCHA los separa, y ahí el nombre repetido pasa a mentir. Truco lo
// pagó y lo renombró: acá se nace con la separación hecha.
//
// `FINISHED` es el ÚNICO terminal, y NO hay un `ABORTED` que lo acompañe: una partida que
// muere sin veredicto no es una transición del juego, es la sala que se muere. Eso lo
// cuenta `MATCH_ABORTED`, que es evento de PLATAFORMA (network/events.ts).
//
// Las TRES fases de la REVANCHA van DESPUÉS del veredicto y ANTES del terminal, y entraron sin
// renombrar nada — que es la razón entera por la que `RESOLVED` y `FINISHED` se separaron antes
// de que existieran. Cada una espera algo distinto, que es lo que las hace fases y no un
// booleano:
//
//   · `REMATCH_WINDOW`      espera que ALGUIEN pida (30 s).
//   · `REMATCH_NEGOTIATION` espera que los DEMÁS respondan (5 s).
//   · `REMATCH_ACCEPTED`    espera el traspaso: la sala nueva ya existe y cada uno tiene su
//                           reserva, pero la vieja se sostiene unos segundos para que el
//                           cliente alcance a consumirla.
//
// SON TRES Y NO DOS, y ahí este repo se aparta de truco: allá hay `REMATCH_WINDOW` y
// `REMATCH_NEGOTIATION` y nada más. La tercera es de v1 (`RematchPhase.ACCEPTED`), y existe
// porque el front pinta una pantalla propia de «revancha aceptada»: sin la fase tendría que
// inferirla de haber recibido un mensaje, que es justo lo que un estado sincronizado evita.
//
// NINGUNA de las tres es terminal: de las tres se sale a `FINISHED`, que sigue siendo el único.
// Una revancha que no prospera no es un final distinto, es el mismo final más tarde.
export type MatchPhase =
  | "NOT_STARTED"
  | "PLAYING"
  | "PRESENTING_MATCH"
  | "REMATCH_WINDOW"
  | "REMATCH_NEGOTIATION"
  | "REMATCH_ACCEPTED"
  | "FINISHED";

// UN EJE, UN CAMPO (spec §7.1): la fase reemplaza los booleanos del v1
// (isRoundFinished + bloqueo derivado + roundEndReason codificaban lo mismo tres veces).
//
// UNA FASE ES UN ESTADO QUE ESPERA ALGO —input, o el vencimiento de su plazo—.
//
// `DEALING` es la VENTANA DE REPARTO (reglas §3.1): al empezar la partida las fichas se
// reparten pero NO se hacen públicas, y cada jugador levanta las suyas con `REVEAL_TILES`
// dentro de 15 s. Mientras falte alguien la ronda no arranca; al vencer, el que no las
// levantó se retira. Es de la RONDA 1 nada más: de la 2 en adelante el reparto revela
// solo. Portado de truco (negocio v27 §12.7).
//
// Es la fase que hace que esperar sea observable, así que existe de verdad: repartir sí
// es síncrono, pero *esperar a que los dos estén ahí* no.
//
// `NEGOTIATING_BET` es la ventana de respuesta del AUMENTO DE APUESTA (en v1,
// `PROPOSE_BET_MULTIPLIER` y sus 10 s). Es una fase y no un booleano por la misma razón que
// las otras tres: es un estado que ESPERA algo —la respuesta del rival, o el vencimiento de
// su plazo— y el modelo tiene UN SOLO `activeDeadline`. Sin fase propia, el plazo de la
// negociación y el del turno serían el mismo campo queriendo decir dos cosas.
//
// CONGELA EL TURNO SIN TOCARLO: `currentTurn` queda intacto, así que al volver a `PLAYING`
// sigue siendo de quien era. Lo único que cambia es quién puede actuar, y eso ya lo dice la
// fase — es `legality.ts#isTurnOf` quien lo lee.
export type RoundPhase = "DEALING" | "PLAYING" | "NEGOTIATING_BET" | "PRESENTING_ROUND";

// Cómo se cerró la ronda: alguien se quedó sin fichas, o nadie puede mover (la tranca).
export type RoundEndReason = "DOMINO" | "BLOCKED";
