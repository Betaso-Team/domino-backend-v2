import type { Logger } from "@/shared/logger";
import { findBareAmounts } from "@/shared/tests/find-bare-amounts";
import { describe, expect, it, vi } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { RoundSummary } from "../../core/state";
import { configOf, replayConfigOf, requestOf } from "../../transports/match-contract";
import { type MatchFinishedPayload, MatchResultRecorder, matchResultOf } from "../match-results";

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
        mode: "CASUAL",
        matchId: "orq-1",
        roomId: "room-9",
        gameModeId: "mode-1v1",
        rateId: "69977c3dc3bf3e710572f941",
        startedAt: null,
        endedAt: "2026-10-05T12:00:00.000Z",
        reason: "SCORE",
        endReason: "SCORE_DOMINO",
        roundsPlayed: 0,
        finalScore: { A: 0, B: 0 },
        stakes: {
          entryFee: { uc: "10.0000" },
          prize: { uc: "18.0000" },
          multiplier: 2,
          isFreeRoom: false,
          bet: null,
        },
        participants: [
          { userId: "p-ana", teamId: winnerTeamId, result: "won", abandon: null },
          { userId: "p-beto", teamId: teamOf(match, 1), result: "lost", abandon: null },
        ],
        payouts: [{ userId: "p-ana", amount: { uc: "18.0000" } }],
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
      payouts: [{ userId: "p-ana", amount: { uc: "36.0000" } }],
    });
  });

  // LA CONVENCIÓN DE MONTOS: ningún monto suelto en el resultado. `multiplier` y `bet.extra` son pesos
  // del ranking, no plata, y siguen siendo números.
  it("no lleva ningún monto suelto; el premio vuelve al mismo número que calculó `payoutOf`", () => {
    const fractional = { ...config, entryFee: 0.1, prize: 0.1 };
    const match = createMatchState(fractional);
    match.acceptedBetLevel = 3;
    match.acceptedBetExtra = 2;

    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      fractional,
      "room-9",
      AT,
    );
    const payload = result?.payload as MatchFinishedPayload;
    expect(findBareAmounts(payload, ["entryFee", "prize", "amount", "amountUc"])).toEqual([]);
    expect(payload).not.toHaveProperty("payouts.0.amountUc");
    // SIN REDONDEAR: el orquestador compara `Number(amount.uc)` contra su planilla, y el ruido de coma
    // flotante del producto (0.1 + 0.1 × 2) tiene que volver idéntico.
    const amount = payload.payouts[0]?.amount.uc;
    expect(Number(amount)).toBe(0.1 + 0.1 * 2);
    expect(payload.stakes).toMatchObject({
      entryFee: { uc: "0.1000" },
      prize: { uc: "0.1000" },
      bet: { level: 3, extra: 2 },
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
        mode: "CASUAL",
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

  it("los hechos del cierre: arranque, manos, marcador y cómo terminó la última", () => {
    const match = createMatchState(config);
    match.startedAt = Date.parse("2026-10-05T11:50:00.000Z");
    if (match.scoreboard) {
      match.scoreboard.teamA = 100;
      match.scoreboard.teamB = 37;
    }
    match.pastRounds.push(
      new RoundSummary().assign({
        roundNumber: 1,
        winnerId: "seat-1",
        winnerTeamId: "A",
        points: 60,
        reason: "DOMINO",
      }),
      new RoundSummary().assign({
        roundNumber: 2,
        winnerId: "seat-1",
        winnerTeamId: "A",
        points: 40,
        reason: "BLOCKED",
      }),
    );

    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" },
      match,
      config,
      "room-9",
      AT,
    );

    expect(result?.payload).toMatchObject({
      startedAt: "2026-10-05T11:50:00.000Z",
      roundsPlayed: 2,
      finalScore: { A: 100, B: 37 },
      endReason: "SCORE_BLOCKED",
    });
  });

  it.each([
    ["voluntary", "ABANDONMENT_VOLUNTARY"],
    ["timeout", "ABANDONMENT_TIMEOUT"],
  ] as const)("el que se fue por %s lo dice, y el cierre también", (how, endReason) => {
    const match = createMatchState(config);
    const quitter = match.players[1];
    if (quitter) {
      quitter.hasAbandoned = true;
      quitter.leftBy = how;
    }

    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "ABANDONMENT" },
      match,
      config,
      "room-9",
      AT,
    );

    expect(result?.payload).toMatchObject({
      endReason,
      participants: [{ abandon: null }, { result: "abandoned", abandon: how }],
    });
  });

  it("una mesa de torneo lleva su modo y su torneo, en el final y en el aborto", () => {
    const tournament = configOf(
      requestOf({
        mode: "TOURNAMENT",
        matchId: "orq-t",
        tournamentId: "t-7",
        participants: config.seats.map(({ userId, displayName, currency }) => ({
          userId,
          displayName,
          currency,
        })),
        seed: "seed",
        teamAssignment: "SEAT_ORDER",
        rules: { pointsToWin: 50 },
      }),
    );
    const match = createMatchState(tournament);

    const finished = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      tournament,
      "room-9",
      AT,
    );
    expect(finished?.payload).toMatchObject({
      mode: "TOURNAMENT",
      tournamentId: "t-7",
      stakes: { entryFee: { uc: "0.0000" }, prize: { uc: "0.0000" }, isFreeRoom: true, bet: null },
    });
    const aborted = matchResultOf(
      { type: "MATCH_ABORTED", reason: "NEVER_STARTED" },
      match,
      tournament,
      "room-9",
      AT,
    );
    expect(aborted?.payload).toMatchObject({ mode: "TOURNAMENT", tournamentId: "t-7" });
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

  it("el premio espera al cobro del aumento en vuelo: si se anuló, sale sin multiplicar", async () => {
    const enqueue = vi.fn(async (_key: string, _routingKey: string, _payload: unknown) => true);
    const recorder = new MatchResultRecorder({
      outbox: { enqueue },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log: silentLogger(),
    });
    const match = createMatchState(config);
    match.acceptedBetLevel = 2;
    match.acceptedBetExtra = 1;
    let settle = () => {};
    const inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });

    recorder.sinkFor(
      config,
      match,
      "room-9",
      () => undefined,
      () => inFlight,
    )([{ type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" }]);
    await new Promise((resume) => setTimeout(resume, 0));
    expect(enqueue).not.toHaveBeenCalled();

    // El orquestador no cobró: el sink del aumento anuló el trato antes de soltar la espera.
    match.acceptedBetLevel = 0;
    match.acceptedBetExtra = 0;
    settle();

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    expect(enqueue.mock.calls[0]?.[2]).toMatchObject({
      stakes: { bet: null },
      payouts: [{ userId: "p-ana", amount: { uc: "18.0000" } }],
    });
  });

  it("drain espera al resultado que aguarda el cobro y a su primer encolado", async () => {
    let enqueued = false;
    const enqueue = vi.fn(async () => {
      enqueued = true;
      return true;
    });
    const recorder = new MatchResultRecorder({
      outbox: { enqueue },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log: silentLogger(),
    });
    const match = createMatchState(config);
    let settle = () => {};
    const inFlight = new Promise<void>((resolve) => {
      settle = resolve;
    });
    recorder.sinkFor(
      config,
      match,
      "room-9",
      () => undefined,
      () => inFlight,
    )([{ type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" }]);

    let drained = false;
    const draining = recorder.drain().then(() => {
      drained = true;
    });
    await new Promise((resume) => setTimeout(resume, 0));
    expect(drained).toBe(false);

    settle();
    await draining;
    expect(enqueued).toBe(true);
  });
});
