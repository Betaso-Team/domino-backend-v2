// Superficie pública de la feature (Regla 4): lo que el composition root y otras features
// consumen. `Clock` y `HistoryReader` salen por acá —y no por un import profundo desde
// `app.config.ts`— porque son los tipos con los que el root NOMBRA lo que le pasa al
// transporte: si el root tuviera que bajar a `core/engine/clock.js` para escribirlos, la
// frontera de la feature existiría solo para los que ya están adentro.
export type { Clock } from "./core/engine/clock.js";
// LOS TIPOS DE LOS PARÁMETROS DE `settlementOf`, y salen porque una firma cuyos parámetros
// no se pueden NOMBRAR obliga a importar hondo, que es justo lo que la Regla 4 evita. Por
// tipado estructural un consumidor puede pasar un literal, pero no puede declarar la
// variable que va a pasar ni escribir el `switch` que decide cuándo liquidar — y el primer
// parámetro ES un evento del catálogo, así que esconder el catálogo y exportar la función
// que lo consume era una superficie que se contradecía sola.
//
// `MatchState` y `DominoMatchConfig` salen como TIPO y no como valor: nombrar el árbol y el
// snapshot es lo que hace falta para pasarlos; construirlos afuera de la feature no.
export type { DominoMatchConfig } from "./core/config.js";
export type { MatchState } from "./core/state/index.js";
export type { NetworkMatchEvent } from "./network/events.js";
export type { HistoryReader } from "./network/history.js";
// La proyección monetaria sale por acá porque su consumidor está AFUERA de la feature: hoy
// el smoke, mañana el adaptador que efectivamente pague. Sale la función y salen sus tipos:
// una instrucción que nadie puede nombrar no se puede recibir, ni loguear, ni auditar.
export {
  settlementOf,
  type SettlementEntry,
  type SettlementInstruction,
  type SettlementKind,
} from "./network/settlement.js";
export { DominoRoom } from "./transports/colyseus/domino-room.js";
// El reparto de partidas entre procesos. Sale por acá porque lo entrega el composition root al
// servidor, que es el único que puede: `matchMaker` no se importa desde ningún otro lado.
// `NoProcessAvailableError` NO sale: nadie lo atrapa —quien recibe el rechazo es Colyseus, que lo
// convierte en un error de matchmaking—, y una superficie pública con tipos que nadie nombra es
// una superficie que nadie puede podar después.
export { selectProcessIdToCreateRoom } from "./transports/colyseus/load-balancer.js";
export { type MatchHttpDeps, registerMatchHttp } from "./transports/http/register-http.js";
// LAS TRES FUNCIONES DE LA FRONTERA Y SUS TIPOS. `requestOf`/`configOf` son el camino de una mesa
// que NACE —el segundo pide el `GameMode` ya resuelto contra el catálogo— y `replayConfigOf` el de
// una que se REBOBINA. Los tres errores salen también: el que pide crear una sala tiene que poder
// distinguir "ese modo no existe" de "ese modo no lo sabemos jugar", y un error que no se puede
// nombrar no se puede atrapar.
export {
  configOf,
  type CreateMatchRequest,
  type MatchParticipant,
  replayConfigOf,
  requestOf,
  SeatCountMismatchError,
  type SeatCredentials,
  UnknownGameModeError,
  UnsupportedGameModeError,
} from "./transports/match-contract.js";
export {
  MatchRegistry,
  type MatchConfigResponse,
  type PublicMatchConfig,
} from "./transports/match-registry.js";
