import { gameModes } from "@/di-container";
import type { GameMode } from "@/features/game-mode";

// EL MODO QUE SIENTA LAS MESAS DE LA SUITE, sembrado UNA vez y en UN solo lugar.
//
// Desde la Tarea 10 ninguna sala nace sin un modo activo en el catálogo, así que cada archivo que
// crea una mesa necesita uno. Escribirlo en cada suite es la deriva garantizada: el día que el
// premio de la mesa cambie, la mitad de los archivos mediría otra economía que la otra mitad —y
// ninguna aserción lo diría—.
//
// VIVE EN `src/tests/` Y NO EN EL ARNÉS E2E DEL MATCH: lo consume `src/tests/e2e.ts`, que es el
// scaffolding de la app ensamblada y no de una feature, y `feature-boundary` (Regla 4) no deja que
// nada de afuera importe de `features/match/tests/`.
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

// LA MESA DE CUATRO. Los mismos números que la de dos a propósito: lo que la distingue es
// `playersQuantity`, y dejar el resto igual hace que cualquier diferencia que una suite mida entre
// las dos mesas sea de la CANTIDAD y no de la economía.
//
// `enableBots` VA EXPLÍCITO y en `true`, que es el default que el repositorio deriva de
// `playersQuantity === 4` (`memory-repository.ts`). Escribirlo es lo que hace que el E2E de la
// partida de cuatro esté midiendo una mesa que reemplaza al que se va, y no una que lo hace por
// accidente el día que ese default cambie.
export const CASUAL_4P: GameMode = await gameModes.create({
  name: "clasica-4p",
  playersQuantity: 4,
  pointsToWin: 100,
  entryFee: 125,
  prize: 250,
  enableBots: true,
});
