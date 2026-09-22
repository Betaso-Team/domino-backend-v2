import { testConfig } from "@/app.config";
import { env } from "@/env";
import type { CreateMatchRequest, MatchParticipant } from "@/features/match";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import { CASUAL_2P } from "./game-mode-catalog";

// Scaffolding de la app ensamblada. Vive en la raíz porque lobby y match lo consumen; dejar una
// copia en cada feature fue exactamente lo que hizo divergir sus tokens y opciones de sala.
export type ParticipantInput = string | MatchParticipant;

export function bootTestServer(port: number): Promise<ColyseusTestServer> {
  return boot(testConfig, port);
}

export const participantOf = (input: ParticipantInput): MatchParticipant =>
  typeof input === "string"
    ? {
        userId: input,
        displayName: `Jugador ${input}`,
        currency: "VES",
      }
    : input;

export function mintToken(player: { readonly userId: string }): string {
  return jwt.sign({ sub: player.userId }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}

export function casualTable(
  seats: readonly ParticipantInput[],
  seed = "seed-e2e",
): CreateMatchRequest {
  const participants = seats.map(participantOf);
  return {
    mode: "CASUAL",
    matchId: `m-${participants.map(({ userId }) => userId).join("-")}`,
    gameModeId: CASUAL_2P.uuid,
    participants,
    seed,
    teamAssignment: "SHUFFLED",
    rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil: se agotó el plazo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
