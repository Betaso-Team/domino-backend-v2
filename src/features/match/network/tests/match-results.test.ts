import type { Logger } from "@/shared/logger";
import { describe, expect, it, vi } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { replayConfigOf } from "../../transports/match-contract";
import { MatchResultRecorder, matchResultOf } from "../match-results";

const config = replayConfigOf({
  matchId: "orq-1",
  gameModeId: "mode-1v1",
  seats: [
    { playerId: "seat-1", userId: "p-ana", displayName: "Ana", currency: "VES" },
    { playerId: "seat-2", userId: "p-beto", displayName: "Beto", currency: "USDT" },
  ],
  seed: "seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  isDealWindowEnabled: true,
  rateId: "69977c3dc3bf3e710572f941",
  entryFee: 10,
  prize: 18,
  multiplier: 2,
  isFreeRoom: false,
});

const AT = new Date("2026-10-05T12:00:00.000Z");
const teamOf = (match: ReturnType<typeof createMatchState>, index: number) =>
  match.players[index]?.teamId as "A" | "B";

describe("matchResultOf", () => {
  it("una partida ganada por puntos: participantes, apuesta de la mesa y premio", () => {
    const match = createMatchState(config);
    const winnerTeamId = teamOf(match, 0);

    expect(
      matchResultOf(
        { type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" },
        match,
        config,
        "room-9",
        AT,
      ),
    ).toEqual({
      routingKey: "domino.match.finished",
      key: "orq-1:finished",
      payload: {
        gameSlug: "domino",
        matchId: "orq-1",
        roomId: "room-9",
        gameModeId: "mode-1v1",
        rateId: "69977c3dc3bf3e710572f941",
        endedAt: "2026-10-05T12:00:00.000Z",
        reason: "SCORE",
        stakes: { entryFee: 10, prize: 18, multiplier: 2, isFreeRoom: false, bet: null },
        participants: [
          { userId: "p-ana", teamId: winnerTeamId, result: "won" },
          { userId: "p-beto", teamId: teamOf(match, 1), result: "lost" },
        ],
        settlement: [{ userId: "p-ana", amountUc: 18 }],
      },
    });
  });

  it("con aumento aceptado: la apuesta viaja y el premio ya la trae", () => {
    const match = createMatchState(config);
    match.acceptedBetLevel = 2;
    match.acceptedBetExtra = 1;

    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      config,
      "room-9",
      AT,
    );

    expect(result?.payload).toMatchObject({
      stakes: { bet: { level: 2, extra: 1 } },
      settlement: [{ userId: "p-ana", amountUc: 36 }],
    });
  });

  it("el que se retiró figura como abandonado, no como perdedor", () => {
    const match = createMatchState(config);
    const quitter = match.players[1];
    if (quitter) quitter.hasAbandoned = true;

    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "ABANDONMENT" },
      match,
      config,
      "room-9",
      AT,
    );

    expect(result?.payload).toMatchObject({
      reason: "ABANDONMENT",
      participants: [{ result: "won" }, { userId: "p-beto", result: "abandoned" }],
    });
  });

  it("una mesa abortada no lleva montos: los reembolsos los decide quien cobró", () => {
    const match = createMatchState(config);

    expect(
      matchResultOf(
        { type: "MATCH_ABORTED", reason: "NEVER_STARTED" },
        match,
        config,
        "room-9",
        AT,
      ),
    ).toEqual({
      routingKey: "domino.match.aborted",
      key: "orq-1:aborted",
      payload: {
        gameSlug: "domino",
        matchId: "orq-1",
        roomId: "room-9",
        gameModeId: "mode-1v1",
        abortedAt: "2026-10-05T12:00:00.000Z",
        reason: "NEVER_STARTED",
        participants: [{ userId: "p-ana" }, { userId: "p-beto" }],
      },
    });
  });

  it("el motivo que solo la sala sabe pisa al del evento", () => {
    const match = createMatchState(config);

    const result = matchResultOf(
      { type: "MATCH_ABORTED", reason: "NEVER_STARTED" },
      match,
      config,
      "room-9",
      AT,
      "CHARGE_REJECTED",
    );

    expect(result?.payload).toMatchObject({ reason: "CHARGE_REJECTED" });
  });

  it("lo que no es un desenlace no es un resultado", () => {
    const match = createMatchState(config);
    expect(
      matchResultOf({ type: "PLAYER_DISCONNECTED", playerId: "seat-1" }, match, config, "r", AT),
    ).toBeUndefined();
  });
});

function silentLogger(): Logger {
  const self: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => self,
  };
  return self;
}

describe("MatchResultRecorder", () => {
  it("encola el desenlace y despierta al despachador", async () => {
    const enqueue = vi.fn(async () => true);
    const wake = vi.fn();
    const recorder = new MatchResultRecorder({
      outbox: { enqueue },
      wake,
      now: () => AT.getTime(),
      log: silentLogger(),
    });
    const match = createMatchState(config);

    recorder.sinkFor(config, match, "room-9")([{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }]);
    await vi.waitFor(() => expect(wake).toHaveBeenCalled());

    expect(enqueue).toHaveBeenCalledWith(
      "orq-1:aborted",
      "domino.match.aborted",
      expect.objectContaining({ reason: "INTERRUPTED" }),
    );
  });

  it("si el outbox falla, reintenta hasta que entra: un resultado perdido es un premio sin pagar", async () => {
    let calls = 0;
    const enqueue = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("mongo caído");
      return true;
    });
    const wake = vi.fn();
    const recorder = new MatchResultRecorder({
      outbox: { enqueue },
      wake,
      now: () => AT.getTime(),
      log: silentLogger(),
      retryBaseMs: 1,
    });

    recorder.sinkFor(
      config,
      createMatchState(config),
      "room-9",
    )([{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }]);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());

    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("consulta el motivo de la sala al cerrar, no al armar el sink", async () => {
    const enqueue = vi.fn(async () => true);
    let reason: "CHARGE_REJECTED" | undefined = undefined;
    const recorder = new MatchResultRecorder({
      outbox: { enqueue },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log: silentLogger(),
    });
    const sink = recorder.sinkFor(config, createMatchState(config), "room-9", () => reason);

    reason = "CHARGE_REJECTED";
    sink([{ type: "MATCH_ABORTED", reason: "NEVER_STARTED" }]);

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect(enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ reason: "CHARGE_REJECTED" }),
    );
  });
});
