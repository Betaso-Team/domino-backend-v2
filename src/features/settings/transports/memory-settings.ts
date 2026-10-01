import type { SectionOverrides, SettingsOverrides } from "../sections";
import type { SettingsBook, SettingsWriter } from "../store";

// LOS OVERRIDES EN MEMORIA, los dos puertos sobre un solo mapa —en producción un solo documento sirve
// a los dos también—.
//
// NO es un doble de test, y en eso el dominó se aparta de truco: es el adaptador de la instancia sin
// `MONGO_URI`, igual que `MemoryHistory` o `MemoryGameModeRepository`. Con una sola instancia no hay a
// quién propagarle la edición, así que la memoria del proceso alcanza; lo que se pierde al reiniciar
// es la edición, que vuelve a los defaults del entorno.
export class MemorySettings implements SettingsBook, SettingsWriter {
  private readonly sections = new Map<string, SectionOverrides>();

  async current(): Promise<SettingsOverrides> {
    return Object.fromEntries(this.sections);
  }

  async save(section: string, patch: SectionOverrides): Promise<SettingsOverrides> {
    this.sections.set(section, { ...this.sections.get(section), ...patch });
    return await this.current();
  }

  async clear(section: string): Promise<SettingsOverrides> {
    this.sections.delete(section);
    return await this.current();
  }
}
