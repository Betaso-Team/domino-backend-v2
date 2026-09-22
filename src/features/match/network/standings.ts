// LO QUE SE CUENTA AFUERA CUANDO UNA PARTIDA CIERRA CON GANADOR, y que no es plata.
//
// El premio tiene su propio camino —`settlementOf`, que proyecta la instrucción monetaria— y no
// pasa por acá. Lo que sí queda de este lado son dos tablas que el jugador mira y que nadie más
// alimenta: el RANKING del dominó y la LIGA.
//
// Son dos puertos y no uno porque no comparten ni destino ni condición, y la asimetría es de v1:
//
//   el RANKING  solo en mesas PAGAS  — en v1 la llamada está adentro del `if (!this.isFreeRoom)`
//               por COLA (`rankings_queue`, con el envoltorio de NestJS)
//   la LIGA     también en las GRATIS — en v1 queda FUERA de ese `if`
//               por HTTP (`POST leagues/save`), que es la excepción entre los reportes
//
// Juntarlos en un solo puerto esconderÍa esa segunda diferencia adentro de un `if`: una mesa
// gratis no reparte puntos de ranking pero SÍ cuenta para la liga.
//
// ⚠ FALTA EL TERCER FLUJO DE v1: `lastWinnersService.saveWin`, el carrusel de últimos ganadores.
// Se deja afuera A PROPÓSITO y no por olvido: su payload es
// `Math.round(entryFee * rate * 100)`, o sea que exige CONVERTIR la moneda con la tasa vigente, y
// este repo no convierte nada por decisión escrita (`network/settlement.ts`: la conversión y el
// redondeo son del que paga, porque convertir dos veces con dos tasas da dos pagos distintos).
// Portarlo es traer el servicio de tasas de v1, que es un incremento propio.

/**
 * LA TRAZA DEL AUMENTO ACEPTADO, y acá el dominó **no copia a truco**. Truco manda el peso de la
 * mesa y NADA del aumento, con el argumento de que hacerlo pesar en el ranking sería una decisión
 * de producto. En el dominó ya es la decisión tomada: v1 calcula
 * `effectiveMultiplier = multiplier + acceptedBetExtra` y manda además este bloque cuando hubo
 * aumento (`ranking.service.ts`, `domino-room-state.ts:583-590`). Copiar la forma de truco habría
 * cambiado los puntos que el jugador recibe.
 *
 * `baseMultiplier` es el del MODO, sin el extra. Va aunque sea derivable —`multiplier - extra`—
 * porque el contrato del otro lado lo pide así: es para soporte, que tiene que poder leer la fila
 * sin rehacer la resta.
 */
export interface BetIncreaseTrace {
  readonly level: number;
  readonly extra: number;
  readonly baseMultiplier: number;
}

/**
 * Una participación que suma al ranking del dominó.
 *
 * LLEVA `userId` Y NO `playerId`, y es la diferencia que más fácil se pasa por alto al portar de
 * truco: allá el `playerId` ES la identidad de plataforma, así que el transporte lo manda tal
 * cual. Acá el `playerId` es OPACO y POSICIONAL (`seat-1`), idéntico en todas las mesas, y mandarlo
 * como `userId` le sumaría los puntos de todo el mundo a una cuenta que no existe.
 *
 * `multiplier` viene YA EFECTIVO —el del modo más el extra aceptado— porque es lo que v1 manda.
 * Quien lo calcula es quien tiene el estado a la vista, no este puerto.
 */
export interface RankingParticipation {
  readonly userId: string;
  readonly username: string;
  readonly profilePicture: string;
  readonly currency: string;
  readonly multiplier: number;
  readonly opponentIds: readonly string[];
  /** Ausente = no hubo aumento en esta partida. Es el reposo, no un dato que falte. */
  readonly betIncrease?: BetIncreaseTrace;
}

export interface RankingFeed {
  // Una participación GANADORA. Solo se reportan las del ganador, como en v1: el ranking del
  // dominó cuenta victorias, no partidas.
  won(entry: RankingParticipation): Promise<void>;
}

/**
 * Un jugador como lo pinta la liga. Va con nombre y foto de los DOS lados porque del otro lado se
 * dibuja una tabla, no un movimiento.
 *
 * `profilePicture` es `string | null` y no `string`, y el `null` es de v1: el endpoint lo recibe
 * así (`profilePicture: player.profilePicture ?? null`). Un invitado sin foto manda `null`, no la
 * cadena vacía, porque del otro lado eso es lo que distingue "no tiene" de "tiene una vacía".
 */
export interface LeaguePlayer {
  readonly userId: string;
  readonly username: string;
  readonly profilePicture: string | null;
}

export interface LeagueResult {
  readonly winner: LeaguePlayer;
  readonly losers: readonly LeaguePlayer[];
}

export interface LeagueFeed {
  record(result: LeagueResult): Promise<void>;
}

/**
 * LOS DOS DESTINOS, JUNTOS, y es lo que el composition root le entrega a la sala. Existe como tipo
 * porque los dos son OPCIONALES por separado —cada uno depende de una variable de entorno
 * distinta— y un par con nombre es lo que evita que el wiring tenga que preguntar dos veces por
 * algo que se decide una sola.
 *
 * Que los dos puedan faltar no es una laguna: sin broker no hay a dónde mandar los puntos y sin
 * backend principal no hay liga, y las dos son configuraciones legítimas fuera de producción. El
 * que falta se ANOTA, nunca se finge (`report-standings.ts`).
 */
export interface StandingsFeeds {
  readonly ranking?: RankingFeed;
  readonly leagues?: LeagueFeed;
}
