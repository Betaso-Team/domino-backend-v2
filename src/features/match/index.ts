// Superficie pública de la feature (Regla 4): lo que el composition root y otras features
// consumen. `Clock` y `HistoryReader` salen por acá —y no por un import profundo desde
// `app.config.ts`— porque son los tipos con los que el root NOMBRA lo que le pasa al
// transporte: si el root tuviera que bajar a `core/engine/clock.js` para escribirlos, la
// frontera de la feature existiría solo para los que ya están adentro.
export type { Clock } from "./core/engine/clock.js";
export type { HistoryReader } from "./network/history.js";
export { DominoRoom } from "./transports/colyseus/domino-room.js";
// El reparto de partidas entre procesos. Sale por acá porque lo entrega el composition root al
// servidor, que es el único que puede: `matchMaker` no se importa desde ningún otro lado.
// `NoProcessAvailableError` NO sale: nadie lo atrapa —quien recibe el rechazo es Colyseus, que lo
// convierte en un error de matchmaking—, y una superficie pública con tipos que nadie nombra es
// una superficie que nadie puede podar después.
export { selectProcessIdToCreateRoom } from "./transports/colyseus/load-balancer.js";
export { type MatchHttpDeps, registerMatchHttp } from "./transports/http/register-http.js";
export {
  configOf,
  type DominoRoomOptions,
  type SeatCredentials,
} from "./transports/match-contract.js";
export {
  MatchRegistry,
  type MatchConfigResponse,
  type PublicMatchConfig,
} from "./transports/match-registry.js";
