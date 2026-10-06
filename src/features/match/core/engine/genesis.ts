// src/features/match/core/engine/genesis.ts
import { type DominoMatchConfig, playerIdsOf } from "../config";
import { Hand, MatchState, PlayerState, Scoreboard } from "../state";
import { InvariantViolationError } from "./errors";
import { assignTeams } from "./team-assignment";

// El árbol inicial. Vive en el DOMINIO y no en la sala, porque formar la mesa
// —quién se sienta dónde y con quién juega— es una regla del juego.
//
// La génesis NO decide los equipos: se los pide a la política (spec §4.3), que es
// lo que permite cambiar de sorteo a parejas por asiento sin tocar el motor.
/** El marcador con el que nace una partida. */
export interface StartingScore {
  readonly teamA: number;
  readonly teamB: number;
}

export const NO_STARTING_SCORE: StartingScore = { teamA: 0, teamB: 0 };

/**
 * `startingScore` existe sólo para probar a mano el final de una partida en local y dev, y se toma
 * tal cual: mantenerlo por debajo de la meta es de quien llama, porque un equipo que naciera en ella
 * habría ganado una partida que nadie jugó.
 */
export function createMatchState(
  config: DominoMatchConfig,
  startingScore: StartingScore = NO_STARTING_SCORE,
): MatchState {
  const match = new MatchState();
  match.scoreboard = new Scoreboard();
  match.scoreboard.teamA = startingScore.teamA;
  match.scoreboard.teamB = startingScore.teamB;
  match.pointsToWin = config.pointsToWin;

  const playerIds = playerIdsOf(config);
  const teams = assignTeams(playerIds, config.teamAssignment, config.seed);

  // UNA SOLA LISTA. El snapshot del asiento trae el id opaco, la identidad externa y el
  // perfil juntos, así que copiarlo es un solo recorrido: una segunda lista de
  // participantes en paralelo tendría que coincidir con ésta en orden y en largo sin que
  // nada lo verifique, y el que se desalinee cobra el premio del de al lado.
  config.seats.forEach((seat, seatIndex) => {
    const teamId = teams[seatIndex];
    if (!teamId) throw new InvariantViolationError(`sin equipo para el asiento ${seatIndex}`);

    const player = new PlayerState();
    player.playerId = seat.playerId;
    player.displayName = seat.displayName;
    player.username = seat.username;
    player.profilePicture = seat.profilePicture;
    player.userId = seat.userId;
    player.currency = seat.currency;
    player.seatIndex = seatIndex;
    player.teamId = teamId;
    player.hand = new Hand();
    match.players.push(player);
  });

  return match;
}
