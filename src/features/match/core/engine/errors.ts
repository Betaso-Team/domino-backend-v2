export abstract class DominoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// El jugador intentó algo ilegal. Se traduce a un mensaje al cliente; NO cierra la partida
// y NO entra al historial (spec §5.1): va al log como rastro antifraude.
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

export class RuleViolationError extends DominoError {
  constructor(readonly code: RuleViolationCode) {
    super(`Regla violada: ${code}`);
  }
}

// El estado dejó de ser confiable. Es un bug: la política de errores lo traduce a
// cerrar la partida (spec §10).
export class InvariantViolationError extends DominoError {}
