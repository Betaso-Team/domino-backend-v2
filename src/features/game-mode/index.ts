// Superficie pública de la feature (Regla 4). Salen los nombres que una capa de afuera no puede
// evitar nombrar: la entidad, el puerto de LECTURA —el composition root para cablear el catálogo y
// el nacimiento de una mesa para recibir el modo que resolvió— y los dos adaptadores, que sólo el
// root puede construir porque sólo él sabe si esta instancia tiene Mongo.
//
// `GameModeRepository` NO sale: el puerto de escritura lo consume el servicio de esta misma
// feature. `GameModeService` sale como VALOR y sus dos dependencias no. Los CUATRO errores tampoco:
// quien los traduce a 404/409/503 es la frontera HTTP de acá adentro.
export type { GameModeReader } from "./core/catalog.js";
export type { GameMode } from "./core/game-mode.js";
export { GameModeService } from "./service.js";
export {
  type GameModeHttpDeps,
  registerGameModeHttp,
} from "./transports/http/register-http.js";
export { MemoryGameModeRepository } from "./transports/memory-repository.js";
export { MongoGameModeRepository } from "./transports/mongo-repository.js";
