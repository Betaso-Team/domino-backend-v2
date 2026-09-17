// src/features/match/core/engine/team-assignment.ts
// CÓMO SE FORMAN LAS PAREJAS. Pura, y el único lugar del motor que lo decide.
//
// El producto pide sorteo aleatorio; truco usa orden de asiento. Las dos formas
// viven acá y se eligen por config, así que cambiar de modelo no toca el motor.
// El día que aparezcan parejas elegidas por los jugadores o armadas por ranking,
// es un caso más en este switch.
import { hashSeed, mulberry32, shuffled } from "@/shared/rng.js";
import type { TeamAssignmentMode } from "../config.js";
import type { PlayerId, TeamId } from "../ids.js";
import { InvariantViolationError } from "./errors.js";

export function assignTeams(
  seats: readonly PlayerId[],
  mode: TeamAssignmentMode,
  seed: string,
): readonly TeamId[] {
  if (seats.length === 0 || seats.length % 2 !== 0) {
    throw new InvariantViolationError(
      `una mesa necesita un número par de asientos, no ${seats.length}`,
    );
  }

  if (mode === "SEAT_ORDER") return seats.map((_, index) => teamAt(index));

  // SHUFFLED: se permutan las POSICIONES y se reparte A/B sobre la permutación.
  // Determinista desde el seed —el mismo PRNG que el Dealer— así que para el
  // jugador es indistinguible del azar y para el servidor es reproducible.
  const permutation = shuffled(
    seats.map((_, index) => index),
    mulberry32(hashSeed(seed, TEAM_DRAW_ROUND)),
  );
  const teams: TeamId[] = new Array(seats.length);
  permutation.forEach((seatIndex, position) => {
    teams[seatIndex] = teamAt(position);
  });
  return teams;
}

// El sorteo de equipos consume su propia "ronda" del seed, así que no le roba
// entropía a ningún reparto ni cambia si se juega una mano más.
const TEAM_DRAW_ROUND = -1;

function teamAt(index: number): TeamId {
  return index % 2 === 0 ? "A" : "B";
}
