import type { InlineGameMode } from "@/features/match";

// LOS MODOS CON LOS QUE LA SUITE SIENTA SUS MESAS, escritos UNA vez y en UN solo lugar.
//
// Toda mesa casual trae su modo en línea (`gameMode`), así que cada archivo que crea una mesa necesita
// uno. Escribirlo en cada suite es la deriva garantizada: el día que el premio de la mesa cambie, la
// mitad de los archivos mediría otra economía que la otra mitad —y ninguna aserción lo diría—.
//
// VIVE EN `src/tests/` Y NO EN EL ARNÉS E2E DEL MATCH: lo consume `src/tests/e2e.ts`, que es el
// scaffolding de la app ensamblada y no de una feature, y `feature-boundary` (Regla 4) no deja que
// nada de afuera importe de `features/match/tests/`.
//
// `uuid` es el `gameModeId` del pedido: no se resuelve contra nada, nombra la mesa en el snapshot, el
// historial, el censo y el resultado.
export interface TableMode {
  readonly uuid: string;
  readonly gameMode: InlineGameMode;
}

export const CASUAL_2P: TableMode = {
  uuid: "6f1c2b0e-2c1a-4a57-9d5e-0a0b1c2d3e41",
  gameMode: {
    name: "clasica-2p",
    playersQuantity: 2,
    pointsToWin: 100,
    multiplier: 1,
    entryFee: 125,
    prize: 250,
    isFreeRoom: false,
    enableBots: false,
  },
};

// LA MESA DE CUATRO. Los mismos números que la de dos a propósito: lo que la distingue es
// `playersQuantity`, y dejar el resto igual hace que cualquier diferencia que una suite mida entre
// las dos mesas sea de la CANTIDAD y no de la economía. `enableBots: true`: el E2E de la partida de
// cuatro mide una mesa que reemplaza al que se va.
export const CASUAL_4P: TableMode = {
  uuid: "6f1c2b0e-2c1a-4a57-9d5e-0a0b1c2d3e42",
  gameMode: { ...CASUAL_2P.gameMode, name: "clasica-4p", playersQuantity: 4, enableBots: true },
};
