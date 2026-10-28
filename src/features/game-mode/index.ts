// Superficie pública de la feature (Regla 4). Salen los nombres que una capa de afuera no puede
// evitar nombrar: la entidad y el puerto de lectura —el composition root para cablear un catálogo,
// y el nacimiento de una mesa para recibir el modo que resolvió— y los adaptadores, que sólo el
// composition root puede construir porque sólo él sabe si esta instancia tiene Mongo.
//
// Los puertos que implementan no salen: quien los consume es el servicio de esta misma feature, y el
// root no necesita nombrarlos para pasar el adaptador que acaba de construir. Tampoco los errores:
// quien los traduce a 404/409/503 es la frontera HTTP, acá adentro.
//
// `GameModeService` y `gameModeHttp` salen como VALOR: el root arma el servicio con los adaptadores
// y el lease de `shared/`, y es el único que lee las llaves de `env` para montar las rutas.
//
// SIN EVENTOS NI OUTBOX: el catálogo no publica a ningún broker. Betaso (y cualquier operador) lee los
// modos del orquestador, que los lee de acá por `GET /internal/game-modes`.
export type { GameModeReader } from "./core/catalog";
export type { GameMode } from "./core/game-mode";
export { GameModeService } from "./service";
export {
  type GameModeHttpDeps,
  gameModeHttp,
} from "./transports/http/register";
export { MemoryGameModeRepository } from "./transports/memory-repository";
export { MongoGameModeRepository } from "./transports/mongo-repository";
