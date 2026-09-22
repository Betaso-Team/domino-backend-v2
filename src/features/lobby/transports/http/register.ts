import { Router } from "express";
import { type LobbyHttpDeps, maintenanceLeverRoutes } from "./maintenance";

export type { LobbyHttpDeps };

// EL HTTP DEL LOBBY VIEJO: sólo la palanca del mantenimiento. Los paths son absolutos, así que se
// monta en la raíz. Portado de truco (`0b0a467`).
export function lobbyHttp(deps: LobbyHttpDeps): Router {
  return Router().use(maintenanceLeverRoutes(deps));
}
