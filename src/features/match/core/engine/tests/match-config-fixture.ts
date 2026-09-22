import type { DominoMatchConfig, MatchSeat } from "../../config";

// EL CONFIG DE UNA MESA PARA LOS TESTS DEL MOTOR, en un solo lugar. Antes cada suite
// escribía el objeto entero a mano, así que un campo nuevo en `DominoMatchConfig` —y esta
// tarea agrega cuatro— rompía seis archivos con el mismo error seis veces.
//
// LOS IDS SIGUEN SIENDO `u1`/`u2` y no `seat-1`/`seat-2`, a propósito: el fixture recibe
// ids INTERNOS ya normalizados, que es exactamente lo que el motor ve. Las reglas que estas
// suites prueban —el reparto, el juez, el marcador, las proyecciones— no consumen identidad
// externa, y meterles `seat-N` solo haría las aserciones más difíciles de leer sin medir
// nada nuevo. Quien quiera la normalización de verdad tiene `match-contract.test.ts`.
export const matchSeat = (playerId: string): MatchSeat => ({
  playerId,
  userId: playerId,
  displayName: `Jugador ${playerId}`,
  currency: "VES",
});

export const matchConfig = (
  playerIds: readonly string[],
  overrides: Partial<DominoMatchConfig> = {},
): DominoMatchConfig => ({
  matchId: "m-test",
  gameModeId: "test",
  seed: "seed-test",
  seats: playerIds.map(matchSeat),
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  // APAGADA por default, al revés que en producción: estas suites prueban la tranca o el
  // conteo, no el control de presencia, y pagar la ceremonia de `REVEAL_TILES` en cada una
  // sería andamiaje que no mide nada. La ventana tiene su propio E2E.
  isDealWindowEnabled: false,
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFee: 125,
  prize: 250,
  // SIN AUMENTO por default, igual que una mesa real sin catálogo: la suite que lo prueba
  // pasa sus niveles por `overrides`. Que el reposo sea la lista vacía es lo mismo que hace
  // producción, así que ninguna otra suite hereda por accidente una mesa que puede cobrar
  // de más.
  betLevels: [],
  isFreeRoom: false,
  // PESO 1, el neutro del ranking: el motor no lo lee y estas suites no reportan nada afuera. La
  // suite del reporte del cierre pasa el peso que quiere medir por `overrides`.
  multiplier: 1,
  ...overrides,
});
