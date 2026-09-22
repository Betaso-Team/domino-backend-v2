import { requireAdminPanelKey } from "@/shared/http/api-key";
import type { Application } from "express";
import { z } from "zod";
import { DEFAULT_MAINTENANCE_MESSAGE } from "../../core/state";
import type { LobbySettings } from "../../settings";

const body = z.strictObject({
  isUnderMaintenance: z.boolean(),
  message: z.string().trim().min(1).max(500).optional(),
});

export interface LobbyHttpDeps {
  readonly settings: LobbySettings;
  readonly adminPanelApiKey: string | undefined;
}

export function registerLobbyHttp(
  app: Application,
  { settings, adminPanelApiKey }: LobbyHttpDeps,
): void {
  // La palanca que abre y cierra el juego no puede nacer pública por una variable ausente.
  if (!adminPanelApiKey) return;

  app.post(
    "/internal/lobby/maintenance",
    requireAdminPanelKey(adminPanelApiKey),
    async (req, res) => {
      const parsed = body.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "BAD_REQUEST" });
        return;
      }
      const value = {
        isUnderMaintenance: parsed.data.isUnderMaintenance,
        maintenanceMessage: parsed.data.message ?? DEFAULT_MAINTENANCE_MESSAGE,
      };
      await settings.set(value);
      res.json(value);
    },
  );
}
