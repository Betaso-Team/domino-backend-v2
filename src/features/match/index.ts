// Superficie pública de la feature (Regla 4): lo que el composition root y otras features
// consumen. `Clock` y `HistoryReader` salen por acá —y no por un import profundo desde
// `app.config.ts`— porque son los tipos con los que el root NOMBRA lo que le pasa al
// transporte: si el root tuviera que bajar a `core/engine/clock.js` para escribirlos, la
// frontera de la feature existiría solo para los que ya están adentro.
export type { Clock } from "./core/engine/clock.js";
export type { HistoryReader } from "./network/history.js";
export { DominoRoom } from "./transports/colyseus/domino-room.js";
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
