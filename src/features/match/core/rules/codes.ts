// EL CATÁLOGO DE MOTIVOS por los que una regla dice que no. Vive acá —y no junto a
// `RuleViolationError`, que es de donde salió— porque el motivo es vocabulario de REGLA y el
// error es el mecanismo con el que el SERVIDOR lo cuenta. El día que estas reglas viajen en un
// paquete que el cliente también consuma, esta lista viaja y el error no.
//
// `engine/errors.ts` la sigue re-exportando, así que ningún consumidor tuvo que cambiar de
// import por la mudanza.
//
// SIGUE SIENDO UNA UNIÓN CERRADA, y acá el repo se aparta de truco a propósito: allá el código
// es `string` porque el front pidió que le alcanzara con algo genérico. Un `string` haría que
// un motivo nuevo mal escrito compilara, y la mitad de estos motivos existen para que el
// jugador sepa si le conviene reintentar. Cerrada, el compilador señala los dos lados —quien lo
// produce y quien lo traduce— cuando entra uno nuevo.
export type RuleViolationCode =
  | "NOT_PLAYING"
  | "NOT_YOUR_TURN"
  | "TILE_NOT_IN_HAND"
  | "TILE_NOT_PLAYABLE"
  | "SIDE_NOT_PLAYABLE"
  | "MUST_PLAY_INSTEAD_OF_DRAWING"
  | "MUST_DRAW_INSTEAD_OF_PASSING"
  | "BONEYARD_EMPTY"
  // Los dos de la ventana de reparto (reglas §3.1): levantar fichas fuera de la ventana,
  // y levantarlas dos veces.
  | "NOT_DEALING"
  | "TILES_ALREADY_SEEN"
  | "MATCH_NOT_IN_PROGRESS"
  // NO HAY RONDA EN CURSO, y es el motivo que nació con este módulo. Del lado del motor eso era
  // una invariante que reventaba (`currentRoundOf`), y está bien que lo sea: el motor solo
  // pregunta desde un comando, o sea con la partida en juego. Una regla que el CLIENTE corre se
  // hace la misma pregunta con la mesa recién abierta y sin ronda, y ahí "todavía no" es la
  // respuesta correcta, no un bug.
  | "NO_ROUND_IN_PROGRESS"
  // LOS DEL AUMENTO DE APUESTA. Son siete y no uno solo a propósito: con plata de por medio,
  // un "no se puede" genérico no le deja al jugador saber si le conviene reintentar en la
  // ronda siguiente, cambiar de nivel, o dejar de insistir. Los seis primeros son los
  // límites que v1 comprueba.
  //
  // EL BALANCE NO ESTÁ ACÁ, y la ausencia es deliberada: comprobarlo es preguntarle a otro
  // servicio —o sea red— y estos comandos son síncronos por contrato. Lo rechaza el cobro,
  // cuando el cobro exista (ver `BetChargePort` en `network/`).
  | "BETTING_DISABLED"
  | "UNKNOWN_BET_LEVEL"
  | "BET_WINDOW_CLOSED"
  | "BET_ALREADY_PENDING"
  | "BET_ALREADY_ACCEPTED"
  | "NO_BET_PENDING"
  // Contestar una oferta que no es para vos. En una mesa de dos es, sobre todo, el
  // proponente intentando aceptarse a sí mismo.
  | "NOT_YOUR_BET";
