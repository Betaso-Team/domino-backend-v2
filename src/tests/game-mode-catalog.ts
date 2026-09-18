import { gameModes } from "@/di-container";
import type { GameMode } from "@/features/game-mode";

// EL MODO QUE SIENTA LAS MESAS DE LA SUITE, sembrado UNA vez y en UN solo lugar.
//
// Desde la Tarea 10 ninguna sala nace sin un modo activo en el catálogo, así que cada archivo que
// crea una mesa necesita uno. Escribirlo en cada suite es la deriva garantizada: el día que el
// premio de la mesa cambie, la mitad de los archivos mediría otra economía que la otra mitad —y
// ninguna aserción lo diría—.
//
// VIVE EN `src/tests/` Y NO EN EL ARNÉS E2E DEL MATCH, y no es preferencia: `feature-boundary`
// (Regla 4) prohíbe que `features/lobby/tests/lobby-e2e.test.ts` importe de
// `features/match/tests/`, y ese archivo también crea mesas de dominó. Un archivo fuera de
// `src/features/` es el único lugar desde el que las tres suites pueden tirar del mismo modo.
//
// SE SIEMBRA EL CATÁLOGO DEL CONTAINER, no uno propio: la sala resuelve `GameModeReader` del root,
// así que un repositorio construido acá sería un modo que la sala nunca ve. `await` en el tope del
// módulo por lo mismo que en `src/replay.ts` —el paquete es ESM y esto es una raíz, no una
// biblioteca—, y así `casualTable()` del arnés sigue siendo sincrónica.
//
// LOS NÚMEROS SON LOS QUE LA SUITE YA USABA (`pointsToWin: 100`, `entryFee: 125`, `prize: 250`):
// venían escritos en cada `casualTable` cuando el request los traía, y conservarlos es lo que hace
// que el único cambio medible de esta tarea sea de DÓNDE salen, no cuánto valen.
export const CASUAL_2P: GameMode = await gameModes.create({
  name: "clasica-2p",
  playersQuantity: 2,
  pointsToWin: 100,
  entryFee: 125,
  prize: 250,
});
