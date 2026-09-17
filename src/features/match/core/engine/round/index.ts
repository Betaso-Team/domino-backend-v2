// `board-ends` y `playable` YA NO SALEN POR ACÁ: se mudaron a `core/rules/`, que es su lugar
// —son derivaciones puras del tablero, o sea reglas del dominó, no piezas del conductor— y
// salen por la puerta de ese módulo. Quien las importaba de acá las importa de allá.
export * from "./block.js";
export * from "./driver.js";
export * from "./first-turn.js";
export * from "./player.js";
export * from "./referee.js";
