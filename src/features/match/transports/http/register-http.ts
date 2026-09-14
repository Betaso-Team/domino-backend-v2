import type { Application as Express } from "express";
import { rootContainer } from "../../../../di-container.js";
import type { Clock } from "../../core/engine/clock.js";
import type { MemoryHistory } from "../../network/transports/memory-history.js";
import { type MatchConfigResponse, MatchRegistry } from "../match-registry.js";

export function registerMatchHttp(app: Express): void {
  app.get("/config/:roomId", (request, response) => {
    const registry = rootContainer.resolve(MatchRegistry);
    const config = registry.publicConfigOf(request.params.roomId);
    if (!config) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const clock = rootContainer.resolve<Clock>("Clock");
    // El seed nunca cruza esta frontera. serverNow viaja con el pedido que el cliente ya
    // hacía, para calcular el offset de reloj con el que lee activeDeadline.
    const body: MatchConfigResponse = { ...config, serverNow: clock.now() };
    response.set("Cache-Control", "no-store").json(body);
  });

  // Para soporte. Detrás de la API key interna cuando exista `auth/internal-key`.
  app.get("/internal/matches/:matchId/history", (request, response) => {
    const entries = (rootContainer.resolve("HistoryPort") as MemoryHistory).of(
      request.params.matchId,
    );
    if (entries.length === 0) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    response.json({ matchId: request.params.matchId, entries });
  });
}
