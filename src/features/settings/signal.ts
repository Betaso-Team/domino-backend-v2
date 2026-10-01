import type { Logger } from "@/shared/logger";
import {
  NO_OVERRIDES,
  type SectionOverrides,
  type SettingsOverrides,
  type SettingsSection,
} from "./sections";
import type { SettingsBook } from "./store";

// CADA CUÁNTO cada proceso busca un cambio. Es la LATENCIA DE LA PALANCA: lo que tarda una edición en
// llegar a las otras instancias del clúster. Constante y NO editable, y no es un olvido: la cadencia
// con la que se trae la configuración no puede salir de la configuración.
export const SETTINGS_POLL_MS = 5_000;

// LO QUE EL RESTO DEL SERVIDOR CONSUME: la configuración como está AHORA, sin esperar la red.
//
// Separada del libro por lo mismo que la señal de mantenimiento —el libro es dónde se lee la verdad,
// esto es cómo se mantiene al día a todos—, y esa separación es la que compra UNA lectura de la base
// por proceso y por pasada, sin importar cuántas mesas nazcan en el medio.
export interface SettingsSignal {
  // Los valores de la sección con sus overrides encima. `T` es el emparejamiento que hace el que
  // llama entre un nombre y un tipo; la señal no conoce ninguna config. Lanza con una sección que
  // nadie cableó.
  effective<T>(section: string): T;
  // Sólo lo que se aparta del default, para que un panel muestre qué se tocó.
  overrides(section: string): SectionOverrides;
}

export interface PolledSettingsSignalDeps {
  readonly book: SettingsBook;
  readonly sections: readonly SettingsSection[];
  readonly intervalMs: number;
  readonly log: Logger;
}

// LA CONFIGURACIÓN DE HOY: lo único que le pregunta a la base, y de donde leen todos los demás.
//
// Dos cosas que la señal de mantenimiento no hace, las dos a propósito:
//
//   · GUARDA EL ÚLTIMO VALOR BUENO cuando una pasada falla, en vez de volver a los defaults. Un hipo
//     de la base que le cambiara la configuración a todos a mitad de sesión sería peor que estar
//     unos segundos viejo.
//   · VALIDA LO QUE LEYÓ, en cada pasada, y descarta ENTERA la sección que no pasa. Un documento
//     editado a mano, o un campo que el tipo ya no tiene, cuestan los defaults y una línea ruidosa
//     en vez de envenenar a toda mesa que nazca después.
export class PolledSettingsSignal implements SettingsSignal {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private last: SettingsOverrides = NO_OVERRIDES;
  private readonly byName: ReadonlyMap<string, SettingsSection>;

  constructor(private readonly deps: PolledSettingsSignalDeps) {
    this.byName = new Map(deps.sections.map((section) => [section.name, section]));
  }

  effective<T>(section: string): T {
    const descriptor = this.byName.get(section);
    if (!descriptor) throw new Error(`sección de configuración desconocida: ${section}`);
    const base = descriptor.defaults() as Record<string, unknown>;
    const overrides = this.last[section] ?? {};
    // Por LISTA BLANCA y no esparciendo los dos: lo que tiene la sección es lo que tiene el tipo, así
    // que un campo sacado del tipo deja de viajar en vez de sobrevivir en la base.
    const effective: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
      effective[key] = key in overrides ? overrides[key] : base[key];
    }
    return effective as T;
  }

  overrides(section: string): SectionOverrides {
    return this.last[section] ?? {};
  }

  // Idempotente, y no sostiene el proceso abierto. La primera pasada sale en el acto.
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // UNA pasada. Pública por dos razones: la suite no tiene que esperar un intervalo real, y el que
  // escribe un override refresca SU proceso en el acto en vez de contestar con un valor que está por
  // dejar de creer.
  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.last = this.validated(await this.deps.book.current());
    } catch (error) {
      // Queda el último valor bueno, y por eso es un warn y no un error: todavía no se rompió nada, y
      // la pasada siguiente lo repara.
      this.deps.log.warn("no se pudo leer la configuración", { err: error });
    } finally {
      this.running = false;
    }
  }

  private validated(raw: SettingsOverrides): SettingsOverrides {
    const kept: Record<string, SectionOverrides> = {};
    for (const [name, stored] of Object.entries(raw)) {
      const section = this.byName.get(name);
      if (!section) continue;
      const parsed = section.schema.safeParse(stored);
      if (parsed.success) {
        kept[name] = parsed.data;
        continue;
      }
      this.deps.log.error("configuración guardada inválida: se ignora la sección entera", {
        section: name,
        detail: parsed.error.issues,
      });
    }
    return kept;
  }
}
