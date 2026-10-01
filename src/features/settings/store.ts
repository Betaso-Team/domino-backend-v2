import type { SectionOverrides, SettingsOverrides } from "./sections";

// DE DÓNDE SE LEEN los overrides. Un solo documento para todas las secciones.
export interface SettingsBook {
  current(): Promise<SettingsOverrides>;
}

// MOVERLOS. Puerto propio y no dos verbos más en el libro, por lo mismo que el interruptor de
// mantenimiento se lee en un lugar y se mueve en otro: cómo se lee la verdad y cómo cambia son
// preguntas distintas con públicos distintos.
//
// Los dos verbos devuelven todo como quedó, así el que escribió no tiene que volver a leer.
export interface SettingsWriter {
  // Aplica los campos que llegan y deja el resto de la sección como estaba.
  save(section: string, patch: SectionOverrides): Promise<SettingsOverrides>;
  // Tira los overrides de la sección enteros: lo que sigue son los defaults otra vez.
  clear(section: string): Promise<SettingsOverrides>;
}
