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
// `subscribeExistingModes` sale para el CLI de una sola vez (`src/subscribe-existing.ts`).
//
// LOS MODOS NO SE PUBLICAN: Betaso (y cualquier proveedor) los lee del orquestador, que los lee de acá
// por `GET /internal/game-modes`. Lo que sí sale son los ANUNCIOS de cada cambio (`domino.config.*`, a
// `betaso_games`, por su propio outbox) para el servicio de notificaciones.
export type { GameModeReader } from "./core/catalog";
export type { GameMode } from "./core/game-mode";
export type { CatalogEvent, CatalogTopic } from "./core/catalog-events";
export { GameModeService } from "./service";
export { OutboxCatalogEvents } from "./transports/outbox-catalog-events";
export {
  type GameModeHttpDeps,
  gameModeHttp,
} from "./transports/http/register";
export { MemoryProviderCatalogs } from "./transports/memory-provider-catalogs";
export { MemoryGameModeRepository } from "./transports/memory-repository";
export { MongoProviderCatalogs } from "./transports/mongo-provider-catalogs";
export {
  MongoGameModeRepository,
  subscribeExistingModes,
} from "./transports/mongo-repository";
