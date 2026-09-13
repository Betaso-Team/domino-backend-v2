// src/features/match/core/engine/state-projections.ts
// Proyecciones PURAS del árbol. Sin reglas del dominó: solo estructura (asientos,
// equipos, actividad en la mano). No son métodos del Schema —el estado es dato
// inerte— y reciben el MatchState por parámetro, así que no son match-bound.
//
// Convención: el SUJETO va primero y el match al final, salvo cuando el match ES
// el sujeto. Así `teamOf(playerId, match)` se lee "el equipo de playerId en esta partida".
import type { PlayerId, TeamId } from "../ids.js";
import type {
  BoneyardState,
  Hand,
  MatchPhase,
  MatchState,
  PlacedTile,
  PlayerState,
  RoundPhase,
  RoundState,
  Scoreboard,
  Turn,
} from "../state/index.js";
import type { BoardSide } from "../state/tile.js";
import { InvariantViolationError } from "./errors.js";

export function playerOf(playerId: PlayerId, match: MatchState): PlayerState {
  const player = match.players.find((candidate) => candidate.playerId === playerId);
  if (!player) throw new InvariantViolationError(`sin asiento para ${playerId}`);
  return player;
}

export function teamOf(playerId: PlayerId, match: MatchState): TeamId {
  return playerOf(playerId, match).teamId as TeamId;
}

export function handOf(playerId: PlayerId, match: MatchState): Hand {
  return playerOf(playerId, match).hand;
}

// Estrecha el `currentRound?` del schema afirmando la invariante: una vez en juego,
// hay ronda. Extrae a un solo lugar el `require*` que si no se repetiría por actor.
export function currentRoundOf(match: MatchState): RoundState {
  if (!match.currentRound) throw new InvariantViolationError("no hay ronda en curso");
  return match.currentRound;
}

export function currentTurnOf(round: RoundState): Turn {
  if (!round.currentTurn) throw new InvariantViolationError("no hay turno en curso");
  return round.currentTurn;
}

// `scoreboard` es `.optional()` por la misma razón que `currentRound`: un `t.ref()` sin
// `.optional()` se auto-instancia, y esa rama tiene que poder arrancar `undefined` antes
// de que la génesis (Tarea 6) la instancie. El costo de esa decisión lo paga quien lee el
// campo —TS lo ve `Scoreboard | undefined` en cada sitio—, así que se angosta UNA vez acá
// en vez de en cada lugar que hace `scoreboard.teamA += puntos` (el scorer de tareas
// siguientes, sobre todo: `?.` no compila del lado de una asignación).
export function scoreboardOf(match: MatchState): Scoreboard {
  if (!match.scoreboard) throw new InvariantViolationError("no hay marcador");
  return match.scoreboard;
}

// EL POZO ES UNA RAMA NULA, y estas dos proyecciones son la única forma de tocarlo.
//
// `boneyardCountOf` es para PREGUNTAR: ausente y agotado dan 0, que es lo correcto para
// toda regla que quiera saber "¿queda de dónde robar?" — la tranca, el veto de pasar.
// `boneyardOf` es para MUTAR: si no hay rama, robar es un bug, no una jugada ilegal, así
// que revienta la invariante en vez de devolver un vacío que el mutador tendría que mirar.
export function boneyardCountOf(round: RoundState): number {
  return round.boneyard?.count ?? 0;
}

export function boneyardOf(round: RoundState): BoneyardState {
  if (!round.boneyard) throw new InvariantViolationError("esta mesa no tiene pozo");
  return round.boneyard;
}

// NARROWING. Colyseus no sincroniza uniones discriminadas, así que en el árbol los ejes
// son `t.string()` (es lo que truco documenta en negocio §4.1, "schema ancho"). Pero eso
// NO tiene por qué llegar a las reglas: el cast vive acá, en un solo archivo, y de este
// lado todo el motor compara contra uniones cerradas. Sin esto, un `side === "Left"` en
// `boardEndsOf` compila, deriva la cadena por el lado equivocado, y como los extremos son
// derivados el tablero entero queda mal sin que nada reviente.
export function sideOf(placed: PlacedTile): BoardSide {
  return placed.side as BoardSide;
}

export function roundPhaseOf(round: RoundState): RoundPhase {
  return round.phase as RoundPhase;
}

export function matchPhaseOf(match: MatchState): MatchPhase {
  return match.phase as MatchPhase;
}

export function isRoundActive(player: PlayerState): boolean {
  return !player.hasAbandoned;
}

export function roundActivePlayers(match: MatchState): PlayerState[] {
  return match.players.filter(isRoundActive);
}

export function hasTeamAbandoned(teamId: TeamId, match: MatchState): boolean {
  const members = match.players.filter((player) => player.teamId === teamId);
  return members.length > 0 && members.every((player) => player.hasAbandoned);
}

// Solo hay dos equipos.
export function opponentTeam(teamId: TeamId): TeamId {
  return teamId === "A" ? "B" : "A";
}

// El orden de turno es el orden de los asientos, en ciclo, empezando por uno dado.
export function turnOrderFrom(playerId: PlayerId, match: MatchState): PlayerState[] {
  const start = playerOf(playerId, match).seatIndex;
  const total = match.players.length;
  const ordered: PlayerState[] = [];
  for (let offset = 0; offset < total; offset += 1) {
    const seat = (start + offset) % total;
    const player = match.players.find((candidate) => candidate.seatIndex === seat);
    if (!player) throw new InvariantViolationError(`asiento ${seat} vacío`);
    ordered.push(player);
  }
  return ordered;
}
