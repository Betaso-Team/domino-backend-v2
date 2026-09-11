import type { DominoMatchConfig } from "../core/config.js";

export interface PublicMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly pointsToWin: number;
}

export interface MatchConfigResponse extends PublicMatchConfig {
  // No cachear: el cliente usa este instante para calcular el offset de activeDeadline.
  readonly serverNow: number;
}

// Registro process-local de partidas vivas. Cuando haya múltiples procesos, esta misma
// frontera pasa a Redis; el contrato público no cambia.
export class MatchRegistry {
  private readonly matches = new Map<string, DominoMatchConfig>();

  register(roomId: string, config: DominoMatchConfig): void {
    this.matches.set(roomId, config);
  }

  remove(roomId: string): void {
    this.matches.delete(roomId);
  }

  publicConfigOf(roomId: string): PublicMatchConfig | undefined {
    const config = this.matches.get(roomId);
    if (!config) return undefined;
    // Allowlist explícita: restar `seed` filtraría solo lo conocido hoy y una propiedad
    // secreta agregada mañana se filtraría al wire. Tampoco se exponen campos derivados
    // de la ventana de reparto.
    return {
      matchId: config.matchId,
      gameModeId: config.gameModeId,
      seats: config.seats,
      pointsToWin: config.pointsToWin,
    };
  }

  matchOf(playerId: string): string | undefined {
    for (const [roomId, config] of this.matches) {
      if (config.seats.includes(playerId)) return roomId;
    }
    return undefined;
  }
}
