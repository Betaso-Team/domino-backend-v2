// src/features/match/core/engine/genesis.ts
import type { DominoMatchConfig } from "../config.js";
import { Hand, MatchState, PlayerState, Scoreboard } from "../state/index.js";
import { InvariantViolationError } from "./errors.js";
import { assignTeams } from "./team-assignment.js";

// El árbol inicial. Vive en el DOMINIO y no en la sala, porque formar la mesa
// —quién se sienta dónde y con quién juega— es una regla del juego.
//
// La génesis NO decide los equipos: se los pide a la política (spec §4.3), que es
// lo que permite cambiar de sorteo a parejas por asiento sin tocar el motor.
export function createMatchState(config: DominoMatchConfig): MatchState {
  const match = new MatchState();
  match.scoreboard = new Scoreboard();
  match.pointsToWin = config.pointsToWin;

  const teams = assignTeams(config.seats, config.teamAssignment, config.seed);

  config.seats.forEach((playerId, seatIndex) => {
    const teamId = teams[seatIndex];
    if (!teamId) throw new InvariantViolationError(`sin equipo para el asiento ${seatIndex}`);

    const player = new PlayerState();
    player.playerId = playerId;
    player.seatIndex = seatIndex;
    player.teamId = teamId;
    player.hand = new Hand();
    match.players.push(player);
  });

  return match;
}
