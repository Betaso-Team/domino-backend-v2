import type { PlayerId, TeamId } from "../ids";
import type { TileLike } from "./tiles";

// LA PARTIDA COMO LA VE UNA REGLA, y la frontera anti-trampa vuelta tipo.
//
// Es el mismo árbol que `state/`, con dos diferencias que son todo el punto:
//
//   1. COLECCIONES PLANAS. `ReadonlyList<T>` en vez de `ArraySchema`. No cuesta un adaptador ni
//      una copia: `ArraySchema<V> implements Array<V>`, así que el árbol del servidor satisface
//      esto tal cual, y el arreglo plano que el cliente decodifica también.
//
//   2. LO GATEADO NO ESTÁ. Ni `Hand.tiles` ni `BoneyardState.tiles` —los dos campos `.view()`
//      del schema—. Las fichas propias entran por UNA puerta, `privateOf`, y esa es la
//      diferencia entre una convención y una garantía: una regla que estire la mano hacia la
//      mano de otro **no compila**. Las del pozo no entran por ninguna: nadie las ve, ni su
//      dueño.
//
// Con eso, "esto se puede compartir con el cliente" deja de ser una promesa y pasa a ser algo
// que `tsc` comprueba: lo que esta vista no expone, no se puede leer.
//
// ⚠ LAS UNIONES VIAJAN COMO `string`, y acá el repo se aparta de truco. Allá el schema declara
// el campo con el tipo TS de la unión (`RoundPhase`) sobre un wire `string`, así que la vista
// puede pedir la unión y el árbol la satisface. La API builder de schema 5 que usa este repo
// infiere `string` a secas (ver la nota compartida en `state/tile.ts`), así que pedir la unión
// acá dejaría al `MatchState` SIN satisfacer la vista, y habría que copiar el árbol para
// angostarlo. Se pide `string` —que el árbol del servidor y el literal del cliente satisfacen
// los dos— y el angostamiento vive en `projections.ts`, en un solo lugar y con nombre.

// ── las colecciones ──────────────────────────────────────────────────────────────────────────

// LO ÚNICO QUE UNA REGLA LE HACE A UNA LISTA: recorrerla, buscar y contar. Nunca la modifica.
//
// Es un tipo propio y no `readonly T[]`, y la omisión que importa es `concat`: el `ArraySchema`
// de Colyseus lo declara devolviendo otro `ArraySchema`, y eso lo vuelve INCOMPATIBLE con
// `ReadonlyArray` —el parámetro de `concat` es contravariante, así que el nodo del servidor no
// encajaría—. Dejando fuera los que no se usan, el árbol del servidor y el arreglo plano del
// cliente satisfacen el MISMO tipo, sin copiar en ninguno de los dos lados.
export interface ReadonlyList<T> extends Iterable<T> {
  readonly length: number;
  readonly [index: number]: T;
  at(index: number): T | undefined;
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  filter(predicate: (value: T, index: number) => boolean): T[];
  some(predicate: (value: T, index: number) => boolean): boolean;
  every(predicate: (value: T, index: number) => boolean): boolean;
  map<U>(fn: (value: T, index: number) => U): U[];
}

// ── lo privado, tras su única puerta ─────────────────────────────────────────────────────────

// Lo que solo ve su dueño. Se pide ENTERO y por jugador, y no como un campo suelto del
// jugador, para que `undefined` signifique exactamente una cosa: **no lo ves**. Con el campo
// suelto, una lista vacía diría a la vez "se quedó sin fichas" y "no me dejan saberlo", que es
// justo la confusión con la que se escribe una regla que en el cliente miente.
export interface PrivatePlayerView {
  readonly tiles: ReadonlyList<TileLike>;
}

// ── el árbol público ─────────────────────────────────────────────────────────────────────────

export interface ScoreboardView {
  readonly teamA: number;
  readonly teamB: number;
}

// Sin `tiles`: eso sale por `privateOf`. `tileCount` sí está, y es el campo derivado que el
// criterio de `PlacedTile` permite justamente porque su fuente está gateada.
export interface HandView {
  readonly tileCount: number;
  readonly isRevealed: boolean;
}

export interface PlayerView {
  readonly playerId: PlayerId;
  readonly teamId: string;
  readonly seatIndex: number;
  readonly connected: boolean;
  readonly hasAbandoned: boolean;
  readonly hasSeenTiles: boolean;
  readonly extraTimeRemainingMs: number;
  readonly hand: HandView;
}

export interface PlacedTileView {
  readonly tile: TileLike;
  readonly playedBy: PlayerId;
  readonly side: string;
}

export interface BoardView {
  readonly tiles: ReadonlyList<PlacedTileView>;
}

// Sin `tiles`, y no por asimetría con la mano: las del pozo son `.view()` y NUNCA se le agregan
// a ninguna audiencia, así que no hay a quién mostrárselas. `count` es lo único que existe para
// todos, y es lo que toda regla necesita —"¿queda de dónde robar?"—.
export interface BoneyardView {
  readonly count: number;
}

export interface TurnView {
  readonly playerId: PlayerId;
  readonly isConsumingExtendedTime: boolean;
  readonly consecutivePasses: number;
}

// Sin `turnRemainingMs`: es el reloj congelado del turno, que solo le sirve al conductor para
// devolverlo al descongelar. Una regla no decide nada con él.
export interface BetOfferView {
  readonly proposerId: PlayerId;
  readonly level: number;
  readonly extra: number;
  readonly additionalEntryFee: number;
}

export interface RoundSummaryView {
  readonly roundNumber: number;
  readonly winnerId: PlayerId;
  readonly winnerTeamId: string;
  readonly points: number;
  readonly reason: string;
}

export interface RoundView {
  readonly roundNumber: number;
  readonly phase: string;
  readonly starterId: PlayerId;
  readonly board: BoardView;
  readonly boneyard?: BoneyardView;
  readonly currentTurn?: TurnView;
  readonly betOffer?: BetOfferView;
}

// ── la raíz, en dos niveles ──────────────────────────────────────────────────────────────────

// LO QUE TODOS VEN. Son DOS tipos y no uno, y la razón es práctica además de conceptual: el
// `MatchState` de Colyseus satisface **esto** por estructura, tal cual, sin envolverlo en nada.
// Así que las reglas que solo miran lo público —la apuesta entera, entre ellas— se llaman con
// el árbol directamente, y solo las que necesitan una mano piden la vista completa.
//
// Sin esta separación, cada `canProposeBet` tendría que construir un envoltorio para preguntar
// algo que no tiene nada de privado.
export interface PublicMatchView {
  readonly phase: string;
  readonly scoreboard?: ScoreboardView;
  readonly players: ReadonlyList<PlayerView>;
  readonly currentRound?: RoundView;
  readonly pastRounds: ReadonlyList<RoundSummaryView>;
  readonly pointsToWin: number;
  readonly activeDeadline: number;
  readonly startedAt: number;
  readonly acceptedBetExtra: number;
  readonly acceptedBetLevel: number;
}

// LO PÚBLICO MÁS LA PUERTA. `undefined` significa **no lo ves**, nunca "no tiene fichas": en el
// servidor siempre contesta, y en el cliente solo por su propio asiento.
//
// Es un método y no un campo para que la asimetría esté en la firma: quien la llame con un id
// ajeno tiene que escribir qué hace cuando no hay respuesta, y ésa es exactamente la revisión
// que uno quiere que ocurra cada vez.
//
// Y que una regla pida `MatchView` en vez de `PublicMatchView` es, por sí solo, la declaración
// de que mira fichas. Se lee en la firma, sin leer el cuerpo.
export interface MatchView extends PublicMatchView {
  privateOf(playerId: PlayerId): PrivatePlayerView | undefined;
}

// El equipo de un jugador, angostado. Va acá y no en `projections.ts` porque es el único lugar
// donde el `string` de la vista se vuelve la unión del dominio sin que haya nada que derivar.
export const teamIdOf = (player: PlayerView): TeamId => player.teamId as TeamId;
