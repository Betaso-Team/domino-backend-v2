// Superficie pública de la feature (Regla 4). Hoy salen DOS nombres y no más: la entidad y el
// puerto de lectura. Son los que una capa de afuera no puede evitar nombrar —el composition
// root para cablear un catálogo, y el nacimiento de una mesa para recibir el modo que
// resolvió—, y el resto todavía no tiene un consumidor externo.
//
// Lo que NO sale, y por qué: `GameModeRepository` y los tres errores los implementan y los
// atrapan los adaptadores de esta misma feature (Tareas 4, 7 y 9), y el contrato Rabbit
// (`GAME_MODE_EXCHANGE`, las claves, `createdEventOf`/`updatedEventOf`) lo consume el outbox,
// que también vive acá adentro. Exportarlos ahora sería una superficie que nadie usa —y una
// superficie que nadie usa es una que nadie puede podar después, porque no se sabe quién
// dependía de qué. Las tareas siguientes la agrandan cuando aparezca el consumidor.
export type { GameModeReader } from "./core/catalog.js";
export type { GameMode } from "./core/game-mode.js";
