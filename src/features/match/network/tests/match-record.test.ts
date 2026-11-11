import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_CONFIG, globalConfigWith } from "../../core/config";
import { createMatchState } from "../../core/engine/genesis";
import { replayConfigOf } from "../../transports/match-contract";
import type { MatchClose } from "../history";
import { matchCloseOf, matchSetupOf, recordEndingSink } from "../match-record";

const config = replayConfigOf({
  matchId: "orq-1",
  gameModeId: "mode-1v1",
  seats: [
    {
      playerId: "seat-1",
      userId: "p-ana",
      displayName: "Ana",
      username: "ana",
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
  betLevels: [
    { level: 2, extra: 1, additionalPoints: 5 },
    { level: 3, extra: 2, additionalPoints: 9 },
  ],
});

const teamOf = (match: ReturnType<typeof createMatchState>, index: number) =>
  match.players[index]?.teamId as "A" | "B";

describe("matchSetupOf", () => {
  it("copia la mesa como se jugó, con el nombre del modo y la sala", () => {
    const match = createMatchState(config, { teamA: 30, teamB: 10 });

    const setup = matchSetupOf(config, DEFAULT_GLOBAL_CONFIG, match, {
      roomId: "room-9",
      gameModeName: "Clásica 1v1",
    });

    expect(setup).toMatchObject({
      roomId: "room-9",
      table: {
        gameModeId: "mode-1v1",
        name: "Clásica 1v1",
        entryFeeInUC: 10,
        prizeInUC: 18,
        isFree: false,
      },
      matchConfig: {
        playersQuantity: 2,
        pointsToWin: 100,
        // EL MARCADOR CON QUE NACIÓ: el de la génesis, no un cero supuesto.
        startingScore: { teamA: 30, teamB: 10 },
        seed: "seed",
        teamAssignment: "SEAT_ORDER",
        isDealWindowEnabled: true,
        tilesPerPlayer: 7,
        betLevels: config.betLevels,
        enableBots: false,
        isRematchEnabled: false,
      },
      seats: [
        {
          id: "seat-1",
          teamId: teamOf(match, 0),
          seat: 0,
          userId: "p-ana",
          displayName: "Ana",
          username: "ana",
          currency: "VES",
        },
        { id: "seat-2", teamId: teamOf(match, 1), seat: 1, userId: "p-beto", currency: "USDT" },
      ],
    });
    expect(setup.seats[1]).not.toHaveProperty("username");
  });

  // EL PROVEEDOR DE CADA ASIENTO, el ámbito del panel: se copia si vino, y el que no lo trajo no lo
  // inventa (una partida de antes, o un orquestador que todavía no lo manda).
  it("copia el proveedor de cada asiento", () => {
    const provided = replayConfigOf({
      ...config,
      seats: [
        { ...config.seats[0], providerId: "betaso" },
        { ...config.seats[1], providerId: "parley" },
      ],
    });

    const { seats } = matchSetupOf(provided, DEFAULT_GLOBAL_CONFIG, createMatchState(provided), {
      roomId: "r",
      gameModeName: "m",
    });

    expect(seats[0]?.providerId).toBe("betaso");
    expect(seats[1]?.providerId).toBe("parley");
  });

  // TODOS LOS PLAZOS, EN UNA SOLA UNIDAD. La reconexión es el único en segundos y se guarda en ms; lo
  // que no es un plazo —las fichas por mano— va aparte.
  it("guarda cada plazo en ms, la reconexión incluida, y nada que no sea un plazo", () => {
    const match = createMatchState(config);
    const global = globalConfigWith({ turnTimeoutMs: 45_000, reconnectionWindowSeconds: 90 });

    const { timeoutsInMs } = matchSetupOf(config, global, match, {
      roomId: "r",
      gameModeName: "m",
    }).matchConfig;

    expect(timeoutsInMs).toMatchObject({
      turnTimeoutMs: 45_000,
      dealingTimeoutMs: DEFAULT_GLOBAL_CONFIG.dealingTimeoutMs,
      reconnectionWindowMs: 90_000,
    });
    expect(timeoutsInMs).not.toHaveProperty("tilesPerPlayer");
    expect(timeoutsInMs).not.toHaveProperty("reconnectionWindowSeconds");
  });
});

describe("matchCloseOf", () => {
  it("una partida ganada: el premio de `payoutOf`, la entrada cobrada y el peso del ranking", () => {
    const match = createMatchState(config);
    const winnerTeamId = teamOf(match, 0);

    expect(
      matchCloseOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, config, {
        entryCharged: true,
      }),
    ).toEqual({
      status: "finished",
      matchEndReason: "SCORE",
      winnerTeamId,
      winnerIds: ["seat-1"],
      rateId: "69977c3dc3bf3e710572f941",
      money: {
        "seat-1": { chargedInUC: 10, prizePaidInUC: 18 },
        "seat-2": { chargedInUC: 10, prizePaidInUC: 0 },
      },
      betMultiplier: { offeredValues: [2, 3], finalValue: 1 },
      rankingMultiplier: { base: 2, extra: 0, final: 2 },
    } satisfies MatchClose);
  });

  // EL AUMENTO QUE QUEDÓ multiplica lo cobrado y lo pagado, y le suma su `extra` al ranking: es lo
  // mismo que el resultado le publica al orquestador.
  it("con aumento cobrado: la mesa entera por el nivel, y el `extra` en el ranking", () => {
    const match = createMatchState(config);
    match.acceptedBetLevel = 3;
    match.acceptedBetExtra = 2;

    const ending = matchCloseOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 1), reason: "ABANDONMENT" },
      match,
      config,
      { entryCharged: true },
    );

    expect(ending).toMatchObject({
      matchEndReason: "ABANDONMENT",
      winnerIds: ["seat-2"],
      money: {
        "seat-1": { chargedInUC: 30, prizePaidInUC: 0 },
        "seat-2": { chargedInUC: 30, prizePaidInUC: 54 },
      },
      betMultiplier: {
        finalValue: 3,
        resultingEntryFeeInUC: 30,
        resultingPrizeInUC: 54,
      },
      rankingMultiplier: { base: 2, extra: 2, final: 4 },
    });
  });

  // EL ORQUESTADOR NO COBRÓ: nadie pagó nada, y el motivo es el de la sala y no el del evento.
  it("una mesa sin cobro: abortada con el motivo de la sala, sin plata ni ganadores", () => {
    const match = createMatchState(config);

    expect(
      matchCloseOf({ type: "MATCH_ABORTED", reason: "NEVER_STARTED" }, match, config, {
        entryCharged: false,
        abortReason: "CHARGE_REJECTED",
      }),
    ).toMatchObject({
      status: "aborted",
      matchEndReason: "CHARGE_REJECTED",
      winnerIds: [],
      money: {
        "seat-1": { chargedInUC: 0, prizePaidInUC: 0 },
        "seat-2": { chargedInUC: 0, prizePaidInUC: 0 },
      },
    });
  });

  it("lo que no es un desenlace no cierra nada", () => {
    const match = createMatchState(config);
    expect(
      matchCloseOf({ type: "ROUND_STARTED", roundNumber: 1 }, match, config, {
        entryCharged: true,
      }),
    ).toBeUndefined();
  });
});

// LA PLATA EN LA MONEDA DEL JUGADOR, elegida del precio congelado con la MISMA regla que la de UC: lo
// cobrado si se confirmó la entrada, el premio si `payoutOf` se lo asigna, los dos al nivel que quedó.
describe("matchCloseOf: en la moneda del jugador", () => {
  const anaPrice = {
    currency: "VES",
    rate: "200",
    entry: "2000.00",
    prize: "3600.00",
    levels: [
      { level: 2, entry: "2000.00", prize: "7200.00" },
      { level: 3, entry: "4000.00", prize: "10800.00" },
    ],
  };
  const priced = replayConfigOf({
    ...config,
    seats: [{ ...config.seats[0], price: anaPrice }, config.seats[1]],
  });

  it("la cabecera guarda el precio con que se sentó, y el asiento sin precio no lo inventa", () => {
    const match = createMatchState(priced);
    const { seats } = matchSetupOf(priced, DEFAULT_GLOBAL_CONFIG, match, {
      roomId: "r",
      gameModeName: "m",
    });
    expect(seats[0]?.price).toEqual(anaPrice);
    expect(seats[1]).not.toHaveProperty("price");
  });

  it("gana sin aumento: la entrada y el premio de x1", () => {
    const match = createMatchState(priced);
    const ending = matchCloseOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      priced,
      { entryCharged: true },
    );
    expect(ending?.money["seat-1"]).toEqual({
      chargedInUC: 10,
      prizePaidInUC: 18,
      chargedInPlayerCurrency: "2000.00",
      prizePaidInPlayerCurrency: "3600.00",
    });
    // EL ASIENTO SIN PRECIO QUEDA EN UC, sin campos vacíos.
    expect(ending?.money["seat-2"]).toEqual({ chargedInUC: 10, prizePaidInUC: 0 });
  });

  // EL AUMENTO: la entrada más lo que costó subir, y el premio del nivel —no el de x1 más algo—.
  it("gana con un aumento a x3: entrada + subir, y el premio de x3", () => {
    const match = createMatchState(priced);
    match.acceptedBetLevel = 3;
    const ending = matchCloseOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      priced,
      { entryCharged: true },
    );
    expect(ending?.money["seat-1"]).toMatchObject({
      chargedInUC: 30,
      prizePaidInUC: 54,
      chargedInPlayerCurrency: "6000.00",
      prizePaidInPlayerCurrency: "10800.00",
    });
  });

  it("pierde con un aumento a x2: paga entrada + subir y no cobra", () => {
    const match = createMatchState(priced);
    match.acceptedBetLevel = 2;
    const ending = matchCloseOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 1), reason: "SCORE" },
      match,
      priced,
      { entryCharged: true },
    );
    expect(ending?.money["seat-1"]).toMatchObject({
      chargedInUC: 20,
      prizePaidInUC: 0,
      chargedInPlayerCurrency: "4000.00",
      prizePaidInPlayerCurrency: "0.00",
    });
  });

  it("sin cobro de la entrada no pagó nada, tampoco en su moneda", () => {
    const match = createMatchState(priced);
    const ending = matchCloseOf({ type: "MATCH_ABORTED", reason: "NEVER_STARTED" }, match, priced, {
      entryCharged: false,
      abortReason: "CHARGE_REJECTED",
    });
    expect(ending?.money["seat-1"]).toMatchObject({
      chargedInPlayerCurrency: "0.00",
      prizePaidInPlayerCurrency: "0.00",
    });
  });

  // UN NIVEL QUE EL PRECIO NO COTIZÓ no se adivina: el asiento queda en UC.
  it("un aumento a un nivel sin precio deja el asiento en UC", () => {
    const match = createMatchState(priced);
    match.acceptedBetLevel = 5;
    const ending = matchCloseOf(
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
      match,
      priced,
      { entryCharged: true },
    );
    expect(ending?.money["seat-1"]).toEqual({ chargedInUC: 50, prizePaidInUC: 90 });
  });
});

describe("recordEndingSink", () => {
  it("una abortada cierra en el acto", () => {
    const match = createMatchState(config);
    const close = vi.fn();
    recordEndingSink({ close }, config, match, {
      entryCharged: () => true,
      abortReason: () => undefined,
      settledBet: () => new Promise(() => {}),
    })([{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }]);

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ status: "aborted", matchEndReason: "INTERRUPTED" }),
    );
  });

  // EL COBRO DEL AUMENTO EN VUELO: con el estado todavía en x2, el registro diría cobrado un aumento
  // que el orquestador puede rechazar. Cierra cuando el cobro resolvió, y relee el estado.
  it("una terminada espera al cobro del aumento, y cierra con lo que quedó", async () => {
    const match = createMatchState(config);
    match.acceptedBetLevel = 2;
    match.acceptedBetExtra = 1;
    const close = vi.fn();
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    recordEndingSink({ close }, config, match, {
      entryCharged: () => true,
      abortReason: () => undefined,
      settledBet: () => settled,
    })([{ type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" }]);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    // El orquestador no cobró: el motor anuló el trato antes de que el cobro resolviera.
    match.acceptedBetLevel = 0;
    match.acceptedBetExtra = 0;
    settle();
    await settled;
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0]?.[0]).toMatchObject({
      money: { "seat-1": { chargedInUC: 10, prizePaidInUC: 18 } },
      betMultiplier: { finalValue: 1 },
    });
  });

  it("sin cobro de aumento que esperar, cierra en el acto", () => {
    const match = createMatchState(config);
    const close = vi.fn();
    recordEndingSink({ close }, config, match, {
      entryCharged: () => true,
      abortReason: () => undefined,
    })([
      { type: "ROUND_STARTED", roundNumber: 1 },
      { type: "MATCH_RESOLVED", winnerTeamId: teamOf(match, 0), reason: "SCORE" },
    ]);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
