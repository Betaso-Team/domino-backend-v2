// Superficie pública de la feature (Regla 4): los puertos, el descriptor con el que se declara una
// sección, los dos adaptadores —que sólo el composition root puede elegir, porque sólo él sabe si esta
// instancia tiene Mongo— y el registro del transporte.
//
// NO conoce NINGUNA configuración. Lo que empareja el nombre de una sección con una forma es el
// composition root, el único lugar que ya conoce todas las features.
export type { SectionOverrides, SettingsOverrides, SettingsSection } from "./sections";
export type { SettingsBook, SettingsWriter } from "./store";
export type { SettingsSignal } from "./signal";
export { PolledSettingsSignal, SETTINGS_POLL_MS } from "./signal";
export { MemorySettings } from "./transports/memory-settings";
export { MongoSettings } from "./transports/mongo-settings";
export {
  SETTINGS_ROUTE,
  type SettingsHttpDeps,
  registerSettingsHttp,
} from "./transports/http/register-http";
