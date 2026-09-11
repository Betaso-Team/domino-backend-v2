import type { DominoMatchConfig, TeamAssignmentMode } from "../core/config.js";

// Contrato en la raíz de transports porque matchmaking crea las salas. `mode` lo deja
// discriminado para sumar otros orígenes sin adivinar por campos opcionales.
export type DominoRoomOptions = {
  readonly mode: "CASUAL";
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly seed: string;
  readonly pointsToWin: number;
  readonly teamAssignment: TeamAssignmentMode;
};

export interface SeatCredentials {
  readonly userId: string;
  readonly token: string;
}

export function configOf(options: DominoRoomOptions): DominoMatchConfig {
  return {
    matchId: options.matchId,
    gameModeId: options.gameModeId,
    seats: options.seats,
    seed: options.seed,
    pointsToWin: options.pointsToWin,
    teamAssignment: options.teamAssignment,
    // La ventana siempre está encendida en este contrato: es control de presencia
    // anti-fraude, no una opción que matchmaking pueda omitir por accidente.
    isDealWindowEnabled: true,
  };
}
