// Superficie pública de la feature (Regla 4): el puerto, el vocabulario, la config y las piezas que
// el composition root necesita para cablearla. Nadie de afuera alcanza el interior.
//
// No sabe de dominó ni de Colyseus: la feature recibe "fulano quiere mandar este gesto" y publica por
// una función que le dan. Quien la enchufa a una partida es el transporte de `match`.
export type {
  Reaction,
  ReactionCatalog,
  ReactionPack,
  ReactionType,
  ReactionsConfig,
} from "./catalog";
export { DEFAULT_REACTIONS_CONFIG } from "./catalog";
export type { ReactionRelayDeps, ReactionSent } from "./relay";
export { ReactionLimiter, ReactionRelay } from "./relay";
export { REACTION_PACKS, StaticReactionCatalog } from "./static-catalog";
export { REACTIONS_ROUTE, reactionsHttp } from "./transports/http";
export { MemoryReactionUsage } from "./transports/memory-reaction-usage";
export {
  REACTION_EVENTS_COLLECTION,
  REACTION_MUTE_EVENTS_COLLECTION,
  MongoReactionUsage,
} from "./transports/mongo-reaction-usage";
export type {
  MuteChangeRecord,
  ReactionGameKind,
  ReactionTable,
  ReactionTableSeat,
  ReactionUsageRecord,
  ReactionUsageStore,
} from "./usage";
export { ReactionUsageLog } from "./usage";
