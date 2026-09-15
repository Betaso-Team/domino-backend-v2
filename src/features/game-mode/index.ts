// Superficie pública de la feature (Regla 4). Salen los nombres que una capa de afuera no puede
// evitar nombrar: la entidad y el puerto de lectura —el composition root para cablear un catálogo,
// y el nacimiento de una mesa para recibir el modo que resolvió— y los DOS adaptadores, que sólo el
// composition root puede construir porque sólo él sabe si esta instancia tiene Mongo.
//
// Los adaptadores salen como VALOR y el puerto que implementan no: quien los construye es el root y
// quien los consume adentro es el servicio de la feature (Tarea 8). Exportar `GameModeRepository`
// hoy sería un tipo que nadie de afuera puede nombrar para nada.
//
// Lo que NO sale, y por qué: los tres errores los atrapan la frontera HTTP y el outbox de esta
// misma feature (Tareas 7 y 9), y el contrato Rabbit (`GAME_MODE_EXCHANGE`, las claves,
// `createdEventOf`/`updatedEventOf`) lo consume el outbox, que también vive acá adentro.
// Exportarlos ahora sería una superficie que nadie usa —y una superficie que nadie usa es una que
// nadie puede podar después, porque no se sabe quién dependía de qué. Las tareas siguientes la
// agrandan cuando aparezca el consumidor.
// El despachador y los dos outbox salen como VALOR por lo mismo que los repositorios: los construye el
// composition root —el único que sabe si esta instancia tiene Mongo y broker— y es también el único
// que arranca y cierra el despachador, porque su ciclo de vida es el del proceso. El puerto
// `GameModeOutbox` NO sale: quien lo consume adentro es el servicio de esta misma feature (Tarea 8), y
// el root no necesita nombrarlo para pasar el adaptador que acaba de construir.
export type { GameModeReader } from "./core/catalog.js";
export type { GameMode } from "./core/game-mode.js";
export { OutboxDispatcher } from "./outbox.js";
export { MemoryGameModeOutbox } from "./transports/memory-outbox.js";
export { MemoryGameModeRepository } from "./transports/memory-repository.js";
export { MongoGameModeOutbox } from "./transports/mongo-outbox.js";
export { MongoGameModeRepository } from "./transports/mongo-repository.js";
