// EL CAP DE 63 CAMPOS (Colyseus 0.18 / @colyseus/schema 5): lo aplica la LIBRERÍA misma,
// en tiempo de DEFINICIÓN, no en runtime. `Metadata.defineField` cuenta los campos —
// incluyendo los heredados vía `.extend()`— y lanza en cuanto el índice llega a 63.
// Consecuencia: una violación real revienta al IMPORTAR el módulo del schema, antes de
// que corra un solo test. Por eso no hay (ni debe haber) un test en runtime tipo
// "Object.keys(node.toJSON()).length < 63": nunca sería lo primero en fallar, y además
// mediría la cantidad equivocada — `toJSON()` omite los campos en `undefined`, así que
// para un nodo recién construido subcuenta el total declarado.
//
// GÉNESIS (Tarea 6), léase antes de escribirla: `MatchState.scoreboard`,
// `MatchState.currentRound`, `RoundState.currentTurn` y `RoundState.boneyard` llevan
// `.optional()` a propósito (ver los comentarios en `match.ts` y `round.ts`) y por lo
// tanto NO vienen instanciados en un nodo recién construido. La génesis es quien tiene
// que instanciarlos explícitamente:
//   · `scoreboard`, `currentRound`, `currentTurn` — SIEMPRE, al arrancar la partida /
//     abrir cada ronda respectivamente.
//   · `boneyard` — CONDICIONALMENTE, según el modo tenga pozo o no (ausente en 4P). Ver
//     `state.test.ts` para el test que fija esta distinción en ambas direcciones.
export * from "./board.js";
export * from "./boneyard.js";
export * from "./match.js";
export * from "./player.js";
export * from "./round.js";
export * from "./tile.js";
// LA MITAD SERVIDOR DE LA FRONTERA DE LAS REGLAS. Sale por el barril del estado —y no por el de
// `rules/`— porque es lo que ADAPTA este árbol a esa vista: la vista no conoce el schema, y ése
// es el punto entero de que exista.
export * from "./view.js";
