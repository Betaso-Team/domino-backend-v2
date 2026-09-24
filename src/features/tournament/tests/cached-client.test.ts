import { describe, expect, it } from "vitest";
import type { TournamentClient, TournamentInfo } from "../client";
import { TournamentUnavailableError } from "../client";
import { CachedTournamentClient } from "../transports/cached-client";

const INFO: TournamentInfo = {
  status: "IN_GAME",
  name: "Torneo de los martes",
  pointsPerLoss: 1,
  playersQuantity: 2,
  pointsToWin: 12,
};

function counting(answer: () => Promise<TournamentInfo> = async () => INFO) {
  const calls = { infoOf: 0, isEnrolled: 0 };
  const source: TournamentClient = {
    infoOf: async () => {
      calls.infoOf++;
      return answer();
    },
    isEnrolled: async () => {
      calls.isEnrolled++;
      return true;
    },
  };
  return { source, calls };
}

// What this file guards is the saving — matchmaking's tick runs four times a second — and its two
// limits: that an enrolment is not cached and that a failure is not stored.
describe("CachedTournamentClient", () => {
  it("un tick de 250 ms no son cuatro peticiones por segundo", async () => {
    const { source, calls } = counting();
    let clock = 1000;
    const client = new CachedTournamentClient(source, 30_000, () => clock);

    for (let i = 0; i < 10; i++) {
      clock += 250;
      await client.infoOf("t1");
    }

    expect(calls.infoOf).toBe(1);
  });

  it("vencido el plazo, vuelve a preguntar", async () => {
    const { source, calls } = counting();
    let clock = 1000;
    const client = new CachedTournamentClient(source, 30_000, () => clock);

    await client.infoOf("t1");
    clock += 30_001;
    await client.infoOf("t1");

    expect(calls.infoOf).toBe(2);
  });

  it("ocho encolándose a la vez comparten una sola petición", async () => {
    const { source, calls } = counting();
    const client = new CachedTournamentClient(source, 30_000, () => 1000);

    await Promise.all(Array.from({ length: 8 }, () => client.infoOf("t1")));

    expect(calls.infoOf).toBe(1);
  });

  it("la inscripción NO se cachea: es de un jugador y de su credencial", async () => {
    const { source, calls } = counting();
    const client = new CachedTournamentClient(source, 30_000, () => 1000);

    await client.isEnrolled("t1", "token-de-u1");
    await client.isEnrolled("t1", "token-de-u1");

    expect(calls.isEnrolled).toBe(2);
  });

  it("un fallo no se guarda: la cola no se cierra 30 s por un hipo de red", async () => {
    let failing = true;
    const { source, calls } = counting(async () => {
      if (failing) throw new TournamentUnavailableError("t1");
      return INFO;
    });
    const client = new CachedTournamentClient(source, 30_000, () => 1000);

    await expect(client.infoOf("t1")).rejects.toBeInstanceOf(TournamentUnavailableError);
    failing = false;

    expect((await client.infoOf("t1")).status).toBe("IN_GAME");
    expect(calls.infoOf).toBe(2);
  });
});
