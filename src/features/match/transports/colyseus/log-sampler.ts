// LOS RECHAZOS DE UN ASIENTO EN EL LOG, MUESTREADOS. Un cliente roto que manda la misma jugada ilegal
// en bucle (o uno malicioso, por debajo del tope de mensajes) escribía una línea `warn` por mensaje:
// el log se llena y lo que importa se pierde. Por asiento y por clase de rechazo pasan las primeras
// `burst` de cada ventana; el resto se cuenta, y al abrir la ventana siguiente sale UNA línea con
// cuántas se callaron. Puro: el reloj entra por parámetro.

export interface SampledLog {
  warn(message: string, detail: Record<string, unknown>): void;
}

export const SAMPLE_BURST = 5;
export const SAMPLE_WINDOW_MS = 60_000;

interface Window {
  startedAt: number;
  logged: number;
  silenced: number;
}

export class LogSampler {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly log: SampledLog,
    private readonly now: () => number = Date.now,
    private readonly burst = SAMPLE_BURST,
    private readonly windowMs = SAMPLE_WINDOW_MS,
  ) {}

  /** @returns si la línea salió. */
  warn(seat: string, kind: string, message: string, detail: Record<string, unknown>): boolean {
    const key = JSON.stringify([seat, kind]);
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (window && window.silenced > 0) {
        this.log.warn("rechazos silenciados en el log", {
          playerId: seat,
          kind,
          silenced: window.silenced,
          windowMs: this.windowMs,
        });
      }
      window = { startedAt: now, logged: 0, silenced: 0 };
      this.windows.set(key, window);
    }
    if (window.logged >= this.burst) {
      window.silenced += 1;
      return false;
    }
    window.logged += 1;
    this.log.warn(message, detail);
    return true;
  }
}
