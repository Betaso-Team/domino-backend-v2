import { z } from "zod";
import type { KeyValueStore } from "../../shared/kv.js";
import { DEFAULT_MAINTENANCE_MESSAGE } from "./core/state.js";

const KEY = "lobby:maintenance";
const maintenance = z.strictObject({
  isUnderMaintenance: z.boolean(),
  maintenanceMessage: z.string().trim().min(1).max(500),
});

export type MaintenanceSettings = z.infer<typeof maintenance>;

const AVAILABLE: MaintenanceSettings = {
  isUnderMaintenance: false,
  maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
};
const FAIL_CLOSED: MaintenanceSettings = { ...AVAILABLE, isUnderMaintenance: true };

export class MaintenanceModeError extends Error {
  override readonly name = "MaintenanceModeError";
}

// Una sola clave compartida. Con Redis sobrevive al proceso y todos los nodos leen lo mismo;
// sin Redis conserva el comportamiento correcto del despliegue de una sola instancia.
export class LobbySettings {
  constructor(private readonly store: KeyValueStore) {}

  async get(): Promise<MaintenanceSettings> {
    const raw = await this.store.get(KEY);
    if (!raw) return AVAILABLE;
    try {
      const parsed = maintenance.safeParse(JSON.parse(raw));
      // Un valor corrupto no puede abrir el juego: mantenimiento es la palanca operativa.
      return parsed.success ? parsed.data : FAIL_CLOSED;
    } catch {
      return FAIL_CLOSED;
    }
  }

  async set(value: MaintenanceSettings): Promise<void> {
    await this.store.set(KEY, JSON.stringify(maintenance.parse(value)));
  }
}
