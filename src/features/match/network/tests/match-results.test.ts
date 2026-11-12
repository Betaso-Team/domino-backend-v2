import type { Logger } from "@/shared/logger";
import { decimal, fixed, stakeAt } from "@/shared/money";
import { findBadAmounts } from "@/shared/tests/find-bad-amounts";
import { describe, expect, it, vi } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { RoundSummary } from "../../core/state";
import { configOf, replayConfigOf, requestOf } from "../../transports/match-contract";
import { type MatchFinishedPayload, MatchResultRecorder, matchResultOf } from "../match-results";

const config = replayConfigOf({
  matchId: "orq-1",
  gameModeId: "mode-1v1",
  seats: [
    {
      playerId: "seat-1",
      userId: "p-ana",
      displayName: "Ana",
      currency: "VES",
      providerId: "betaso",
    },
    {
      playerId: "seat-2",
      userId: "p-beto",
      displayName: "Beto",
      currency: "USDT",
      providerId: "betaso",
    },
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
          currency: "UC",
          entryFee: "10.0000",
          prize: "18.0000",
          multiplier: 2,
          isFreeRoom: false,
          bet: null,
        },
        participants: [
          { userId: "p-ana", teamId: winnerTeamId, result: "won", abandon: null, playedSeconds: 0 },
          {
            userId: "p-beto",
            teamId: teamOf(match, 1),
            result: "lost",
            abandon: null,
            playedSeconds: 0,
          },
        ],
        payouts: [{ userId: "p-ana", currency: "UC", amount: "18.0000" }],
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
      payouts: [{ userId: "p-ana", currency: "UC", amount: "36.0000" }],
    });
  });

  // LA CONVENCIÓN DE MONTOS v2: ningún número ni objeto por moneda en el resultado; `stakes` y cada
  // premio son entidades en UC. `multiplier` y `bet.extra` son pesos del ranking, no plata, y siguen
  // siendo números.
  it("no lleva ningún monto fuera de la convención; el premio es el decimal que calculó `payoutOf`", () => {
    const fractional = { ...config, entryFee: decimal("0.1"), prize: decimal("0.1") };
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
    expect(findBadAmounts(payload, ["entryFee", "prize", "amount", "amountUc"])).toEqual([]);
    expect(payload).not.toHaveProperty("payouts.0.amountUc");
    expect(JSON.stringify(payload)).not.toContain('"uc"');
    expect(payload.payouts[0]?.currency).toBe("UC");
    // EXACTO: el orquestador compara `amount` como decimal con `stakeAt(prize, nivel)`. En `number`
    // era `0.1 + 0.1 × 2` = 0.30000000000000004, y el premio no coincidía.
    expect(payload.payouts[0]?.amount).toBe("0.3000");
    expect(payload.stakes).toMatchObject({
      currency: "UC",
      entryFee: "0.1000",
      prize: "0.1000",
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
    // El socket caído es un retiro del reloj, así que cierra como el `timeout`.
    ["disconnected", "ABANDONMENT_TIMEOUT"],
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

  it("los segundos jugados: hasta que se fue o hasta el cierre, enteros hacia abajo", () => {
    const match = createMatchState(config);
    match.startedAt = AT.getTime() - 600_900;
    const quitter = match.players[1];
    if (quitter) {
      quitter.hasAbandoned = true;
      quitter.leftBy = "disconnected";
      quitter.leftAt = AT.getTime() - 300_500;
    }

    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "ABANDONMENT" },
      match,
      config,
      "room-9",
      AT,
    );

    expect((result?.payload as MatchFinishedPayload).participants).toMatchObject([
      { abandon: null, playedSeconds: 600 },
      { result: "abandoned", abandon: "disconnected", playedSeconds: 300 },
    ]);
  });

  it("sin juego arrancado los segundos son 0, y nunca negativos", () => {
    const never = createMatchState(config);
    const early = createMatchState(config);
    early.startedAt = AT.getTime();
    const quitter = early.players[1];
    if (quitter) {
      quitter.hasAbandoned = true;
      quitter.leftBy = "timeout";
      quitter.leftAt = AT.getTime() - 5_000;
    }
    const resolved = (match: ReturnType<typeof createMatchState>) =>
      (
        matchResultOf(
          { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "ABANDONMENT" },
          match,
          config,
          "room-9",
          AT,
        )?.payload as MatchFinishedPayload
      ).participants.map(({ playedSeconds }) => playedSeconds);

    expect(resolved(never)).toEqual([0, 0]);
    expect(resolved(early)).toEqual([0, 0]);
  });

  it("una mesa de torneo lleva su modo y su torneo, en el final y en el aborto", () => {
    const tournament = configOf(
      requestOf({
        mode: "TOURNAMENT",
        matchId: "orq-t",
        tournamentId: "t-7",
        participants: config.seats.map(({ userId, displayName, currency, providerId }) => ({
          userId,
          displayName,
          currency,
          providerId,
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
      stakes: {
        currency: "UC",
        entryFee: "0.0000",
        prize: "0.0000",
        isFreeRoom: true,
        bet: null,
      },
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
      { exclusiveKey: "orq-1" },
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
      expect.anything(),
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
      payouts: [{ userId: "p-ana", currency: "UC", amount: "18.0000" }],
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

// MONGO CAÍDO EN EL APAGADO: el drenado sigue reintentando hasta su plazo; si se rinde, el resultado
// queda ENTERO en el log. Y la marca compartida dice que el resultado está en memoria mientras falla.
describe("MatchResultRecorder: el apagado con Mongo caído", () => {
  const aborted = [{ type: "MATCH_ABORTED", reason: "INTERRUPTED" } as const];

  it("drain sigue reintentando, no sólo el primer intento, hasta que entra", async () => {
    let up = false;
    const enqueue = vi.fn(async () => {
      if (!up) throw new Error("mongo caído");
      return true;
    });
    const recorder = new MatchResultRecorder({
      outbox: { enqueue },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log: silentLogger(),
      // Sin el drenado, el próximo intento sería en una hora.
      retryBaseMs: 3_600_000,
    });
    recorder.sinkFor(config, createMatchState(config), "room-9")(aborted);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());

    const draining = recorder.drain(5_000);
    setTimeout(() => {
      up = true;
    }, 600);
    await draining;

    expect(enqueue.mock.calls.length).toBeGreaterThan(2);
    expect(enqueue.mock.results.at(-1)?.type).toBe("return");
  });

  it("al vencer el plazo se rinde y escribe el cuerpo entero a nivel error", async () => {
    const log = silentLogger();
    const recorder = new MatchResultRecorder({
      outbox: {
        enqueue: async () => {
          throw new Error("mongo caído");
        },
      },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log,
      retryBaseMs: 1,
    });
    recorder.sinkFor(config, createMatchState(config), "room-9")(aborted);

    await recorder.drain(300);

    expect(log.error).toHaveBeenCalledWith(
      "resultado de partida SIN ENCOLAR: el apagado se rindió; reproducir a mano",
      {
        key: "orq-1:aborted",
        routingKey: "domino.match.aborted",
        payload: expect.objectContaining({ matchId: "orq-1", reason: "INTERRUPTED" }),
      },
    );
  });

  it("si la partida ya tenía el OTRO desenlace, lo dice con el cuerpo entero", async () => {
    const log = silentLogger();
    const recorder = new MatchResultRecorder({
      outbox: { enqueue: async () => false, present: async () => new Set(["orq-1:finished"]) },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log,
    });
    recorder.sinkFor(config, createMatchState(config), "room-9")(aborted);
    await recorder.drain(1_000);

    expect(log.error).toHaveBeenCalledWith(
      "la partida ya tenía el OTRO desenlace en el outbox; éste no se publica",
      expect.objectContaining({ key: "orq-1:aborted" }),
    );
  });

  it("marca el resultado mientras falla y lo desmarca al entrar", async () => {
    let calls = 0;
    const marks = { hold: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    const recorder = new MatchResultRecorder({
      outbox: {
        enqueue: async () => {
          calls += 1;
          if (calls < 3) throw new Error("mongo caído");
          return true;
        },
      },
      wake: vi.fn(),
      now: () => AT.getTime(),
      log: silentLogger(),
      marks,
      retryBaseMs: 1,
    });
    recorder.sinkFor(config, createMatchState(config), "room-9")(aborted);
    await recorder.drain(2_000);

    expect(marks.hold).toHaveBeenCalledTimes(2);
    expect(marks.hold).toHaveBeenCalledWith("orq-1");
    expect(marks.release).toHaveBeenCalledOnce();
  });
});

// EL PREMIO QUE PUBLICA EL DOMINÓ ES EL QUE CALCULA EL ORQUESTADOR, al dígito. El orquestador parsea
// `payouts[].amount` como `Decimal` y lo compara EXACTO con `stakeAt(roster.prize, nivel)`: un premio que
// difiere en el último decimal va a la DLQ y el ganador no cobra. Con `number`, el x6 de 0.02 era
// `0.02 + 0.1` = 0.12000000000000001.
describe("el premio publicado es `stakeAt(prize, nivel)` del orquestador", () => {
  const payoutAt = (prize: string, level: number): string | undefined => {
    const table = { ...config, prize: decimal(prize) };
    const match = createMatchState(table);
    if (level > 1) {
      match.acceptedBetLevel = level;
      match.acceptedBetExtra = 1;
    }
    const result = matchResultOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      table,
      "room-9",
      AT,
    );
    return (result?.payload as MatchFinishedPayload).payouts[0]?.amount;
  };
  const expected = (prize: string, level: number) =>
    fixed(stakeAt(decimal(prize), level).toString(), 4);

  it("con premio 0.02, en todo nivel de 2 a 100", () => {
    for (let level = 2; level <= 100; level += 1) {
      expect(payoutAt("0.02", level), `nivel ${level}`).toBe(expected("0.02", level));
    }
    expect(payoutAt("0.02", 6)).toBe("0.1200");
  });

  it.each([
    "0.01",
    "0.03",
    "0.07",
    "0.1",
    "0.15",
    "0.3",
    "1.5",
    "2.75",
    "18",
    "33.3333",
    "1000.0001",
  ])("con premio %s, en una muestra de niveles", (prize) => {
    for (const level of [1, 2, 3, 5, 6, 7, 10, 64, 99, 100]) {
      expect(payoutAt(prize, level), `nivel ${level}`).toBe(expected(prize, level));
    }
  });
});
