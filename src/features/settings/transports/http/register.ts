import { Router } from "express";
import { type SettingsRoutesDeps, settingsRoutes } from "./settings";

export type SettingsHttpDeps = SettingsRoutesDeps;

// EL HTTP DE LA CONFIGURACIÓN EN CALIENTE. Los paths son absolutos, así que se monta en la raíz.
// Portado de truco (`0b0a467`).
export function settingsHttp(deps: SettingsHttpDeps): Router {
  return Router().use(settingsRoutes(deps));
}
