import { matchResults, rootContainer } from "@/di-container";
import type { Logger } from "@/shared/logger";
import { joinAs } from "@/tests/e2e";
import { fakeOrchestrator } from "@/tests/fake-orchestrator";
import { CASUAL_2P } from "@/tests/table-modes";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DominoMatchConfig } from "../core/config";
import { ucText } from "../network/amounts";
import {
  ChargeRejectedError,
  OrchestratorBetCharger,
  type OrchestratorCharges,
} from "../network/orchestrator-charges";
import { act, bootServer, clientOf, revealHands, seatPair, waitUntil } from "./e2e-harness";

const PORT = 2607;

// UNA MESA NO MUEVE PLATA EN DOMINÓ: dice qué pasó y pide que se cobre. El resultado va al outbox de
// `tablea_gaming` y la entrada y el aumento se le piden cobrar al orquestador.
const LEVELS = [{ level: 2, extra: 1, additionalPoints: 1 }] as const;

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

describe("las mesas del orquestador: resultado publicado, cobros pedidos, nada movido acá", () => {
  let server: Awaited<ReturnType<typeof bootServer>>;
  const chargeBet = vi.fn<OrchestratorCharges["chargeBet"]>(async () => undefined);
  let previousCharger: OrchestratorBetCharger;

  beforeAll(async () => {
    server = await bootServer(PORT);
    previousCharger = rootContainer.resolve(OrchestratorBetCharger);
    rootContainer.register(OrchestratorBetCharger, {
      useValue: new OrchestratorBetCharger({
        orchestrator: { chargeEntry: vi.fn(async () => undefined), chargeBet },
        timeoutMs: 1_000,
        log: silentLogger(),
      }),
    });
  });
  afterAll(async () => {
    rootContainer.register(OrchestratorBetCharger, { useValue: previousCharger });
    await server.shutdown();
  });
  beforeEach(() => {
    chargeBet.mockReset();
    chargeBet.mockImplementation(async () => undefined);
  });
  afterEach(async () => {
    await server.cleanup();
    vi.restoreAllMocks();
  });

  const configOfRoom = (roomId: string) =>
    (server.getRoomById(roomId) as unknown as { config: DominoMatchConfig }).config;

  it("los niveles los trae el pedido del orquestador", async () => {
    const match = await seatPair(server, ["n1", "n2"], undefined, { betLevels: [...LEVELS] });
    expect(configOfRoom(match.roomId).betLevels).toEqual(LEVELS);
  });

  it("sin niveles en el pedido, la mesa no ofrece aumentar", async () => {
    const match = await seatPair(server, ["z1", "z2"]);
    expect(configOfRoom(match.roomId).betLevels).toEqual([]);
  });

  // UNA SOLA RESPUESTA POR AUMENTO: con el cobro en vuelo la mesa sigue en x1, congelada y con la oferta
  // aceptada; si el orquestador no cobra, la oferta se anula y el aumento nunca llegó a la mesa.
  it("un aumento aceptado se le pide cobrar al orquestador, y si no cobra se anula sin haber subido", async () => {
    let refuse = () => {};
    chargeBet.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          refuse = () => reject(new ChargeRejectedError("INSUFFICIENT_FUNDS"));
        }),
    );
    const match = await seatPair(server, ["b1", "b2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);
    const types: string[] = [];
    clientOf(match, "b1").onMessage("events", (batch: Array<{ type: string }>) =>
      types.push(...batch.map((event) => event.type)),
    );

    clientOf(match, "b1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => match.serverState.currentRound?.betOffer !== undefined);
    clientOf(match, "b2").send("RESPOND_BET_MULTIPLIER", { accept: true });

    await waitUntil(() => chargeBet.mock.calls.length === 1);
    expect(chargeBet).toHaveBeenCalledWith(match.config.matchId, 0, 2);
    expect(match.serverState.acceptedBetLevel).toBe(0);
    expect(match.serverState.currentRound?.betOffer?.accepted).toBe(true);
    expect(match.serverState.currentRound?.phase).toBe("NEGOTIATING_BET");

    refuse();
    await waitUntil(() => match.serverState.currentRound?.betOffer === undefined);
    expect(match.serverState.currentRound?.phase).toBe("PLAYING");
    // ANULADO: la mesa nunca dijo x2 y el cupo de "uno por partida" queda libre.
    expect(match.serverState.acceptedBetLevel).toBe(0);
    await waitUntil(() => types.includes("MULTIPLIER_REVOKED"));
    expect(types).not.toContain("MULTIPLIER_CONFIRMED");
  });

  it("un aumento queda en la mesa recién cuando el orquestador lo cobró", async () => {
    let pay = () => {};
    chargeBet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pay = resolve;
        }),
    );
    const match = await seatPair(server, ["c1", "c2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);
    const types: string[] = [];
    clientOf(match, "c2").onMessage("events", (batch: Array<{ type: string }>) =>
      types.push(...batch.map((event) => event.type)),
    );

    clientOf(match, "c1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => match.serverState.currentRound?.betOffer !== undefined);
    clientOf(match, "c2").send("RESPOND_BET_MULTIPLIER", { accept: true });

    await waitUntil(() => chargeBet.mock.calls.length === 1);
    await new Promise((resume) => setTimeout(resume, 20));
    expect(match.serverState.acceptedBetLevel).toBe(0);

    pay();
    await waitUntil(() => match.serverState.acceptedBetLevel === 2);
    expect(match.serverState.currentRound?.betOffer).toBeUndefined();
    expect(match.serverState.currentRound?.phase).toBe("PLAYING");
    await waitUntil(() => types.includes("MULTIPLIER_CONFIRMED"));
    expect(types).not.toContain("MULTIPLIER_REVOKED");
  });

  it("la partida que termina con el cobro en vuelo publica el premio del aumento si se cobró", async () => {
    let pay = () => {};
    chargeBet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pay = resolve;
        }),
    );
    const enqueue = vi.spyOn(matchResults, "enqueue");
    const match = await seatPair(server, ["p1", "p2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);
    clientOf(match, "p1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => match.serverState.currentRound?.betOffer !== undefined);
    clientOf(match, "p2").send("RESPOND_BET_MULTIPLIER", { accept: true });
    await waitUntil(() => chargeBet.mock.calls.length === 1);

    await act(match, "p2", "ABANDON");
    await new Promise((resume) => setTimeout(resume, 20));
    const key = `${match.config.matchId}:finished`;
    expect((await matchResults.present([key])).has(key)).toBe(false);

    pay();
    await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
    const payload = enqueue.mock.calls.find((call) => call[0] === key)?.[2];
    expect(payload).toMatchObject({ stakes: { bet: { level: 2 } } });
    expect(match.serverState.acceptedBetLevel).toBe(2);
  });

  // LO QUE CUESTA ACEPTAR, EN LA CONVENCIÓN DE MONTOS, decodificado del lado del CLIENTE: en el estado
  // (texto en UC, la moneda de la mesa) y en el evento `MULTIPLIER_AGREED` que difunde la sala (una
  // entidad con `currency: "UC"`). Adentro sigue siendo un número, que es lo que mira el cobro.
  it("el aumento viaja como texto en UC en el estado y en el evento", async () => {
    const match = await seatPair(server, ["v1", "v2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);
    const fee = ucText(configOfRoom(match.roomId).entryFee);
    const responder = clientOf(match, "v2");
    const batches: unknown[][] = [];
    responder.onMessage("events", (batch: unknown[]) => batches.push(batch));
    const offerOf = () =>
      (
        responder.state as unknown as {
          currentRound?: { betOffer?: { additionalEntryFee: unknown } };
        }
      ).currentRound?.betOffer;

    clientOf(match, "v1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => offerOf() !== undefined);
    expect(offerOf()?.additionalEntryFee).toBe(fee);

    responder.send("RESPOND_BET_MULTIPLIER", { accept: true });
    const agreedOf = () =>
      batches.flat().find((event) => (event as { type?: string }).type === "MULTIPLIER_AGREED");
    await waitUntil(() => agreedOf() !== undefined);
    expect(agreedOf()).toMatchObject({ level: 2, currency: "UC", additionalEntryFee: fee });
    await waitUntil(() => chargeBet.mock.calls.length === 1);
  });

  it("la partida que termina con el cobro del aumento en vuelo publica el premio recién con el cobro resuelto", async () => {
    let refuse = () => {};
    chargeBet.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          refuse = () => reject(new ChargeRejectedError("INSUFFICIENT_FUNDS"));
        }),
    );
    const enqueue = vi.spyOn(matchResults, "enqueue");
    const match = await seatPair(server, ["w1", "w2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);
    clientOf(match, "w1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => match.serverState.currentRound?.betOffer !== undefined);
    clientOf(match, "w2").send("RESPOND_BET_MULTIPLIER", { accept: true });
    await waitUntil(() => chargeBet.mock.calls.length === 1);

    // Con el cobro todavía en vuelo la mesa sigue en x1, y el que se va le da la partida al otro.
    await act(match, "w2", "ABANDON");
    await new Promise((resume) => setTimeout(resume, 20));
    const key = `${match.config.matchId}:finished`;
    expect((await matchResults.present([key])).has(key)).toBe(false);

    refuse();
    await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
    const payload = enqueue.mock.calls.find((call) => call[0] === key)?.[2];
    expect(payload).toMatchObject({
      stakes: { bet: null },
      payouts: [{ currency: "UC", amount: ucText(configOfRoom(match.roomId).prize) }],
    });
  });

  it("con la mesa completa pide el cobro de la entrada, y no arranca hasta el sí", async () => {
    let release!: () => void;
    fakeOrchestrator.failEntryWith(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const match = await seatPair(server, ["e1", "e2"]);
      await waitUntil(() => fakeOrchestrator.entries.includes(match.config.matchId));
      await new Promise((resume) => setTimeout(resume, 20));
      expect(match.serverState.phase).toBe("NOT_STARTED");

      release();
      await waitUntil(() => match.serverState.phase === "PLAYING");
      expect(fakeOrchestrator.entries.filter((id) => id === match.config.matchId)).toHaveLength(1);
    } finally {
      fakeOrchestrator.failEntryWith(undefined);
    }
  });

  it("si el orquestador no cobra la entrada, la mesa se cierra sin arrancar y sale abortada", async () => {
    // EL RECHAZO SE SUELTA CON LOS DOS ESCUCHANDO: un rechazo inmediato llega antes de que el arnés
    // devuelva los clientes, y el comodín de `src/tests/e2e.ts` se traga el aviso.
    let refuse = () => {};
    fakeOrchestrator.failEntryWith(
      () =>
        new Promise<void>((_, reject) => {
          refuse = () => reject(new ChargeRejectedError("INSUFFICIENT_FUNDS"));
        }),
    );
    try {
      const match = await seatPair(server, ["x1", "x2"]);
      const reasons: string[] = [];
      for (const client of Object.values(match.clients))
        client.onMessage("matchCancelled", (message: { reason: string }) => {
          reasons.push(message.reason);
        });
      await waitUntil(() => fakeOrchestrator.entries.includes(match.config.matchId));
      refuse();
      const key = `${match.config.matchId}:aborted`;
      await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
      await waitUntil(() => reasons.length === 2);
      expect(reasons).toEqual(["CHARGE_REJECTED", "CHARGE_REJECTED"]);
      expect(match.serverState.phase).toBe("NOT_STARTED");
      expect(server.getRoomById(match.roomId)).toBeUndefined();
    } finally {
      fakeOrchestrator.failEntryWith(undefined);
    }
  });

  it("con la mesa incompleta no se cobra nada", async () => {
    const before = fakeOrchestrator.entries.length;
    const room = await server.createRoom("domino", {
      mode: "CASUAL",
      matchId: "m-solo",
      gameModeId: CASUAL_2P.uuid,
      gameMode: CASUAL_2P.gameMode,
      participants: [
        { userId: "s1", displayName: "s1", currency: "VES", providerId: "betaso" },
        { userId: "s2", displayName: "s2", currency: "VES", providerId: "betaso" },
      ],
      seed: "seed",
      teamAssignment: "SEAT_ORDER",
      rateId: "rate-1",
    });
    await joinAs(server, room.roomId, "s1");
    await new Promise((resume) => setTimeout(resume, 20));
    expect(fakeOrchestrator.entries.length).toBe(before);
  });

  // EL PLAZO DE OCUPACIÓN VENCIDO SE AVISA ANTES DE CERRAR. La sala cierra con 4000 (CONSENTED), que es
  // el mismo código del socket desplazado por otra pestaña: sin el aviso, el front le decía al que sí
  // entró «abriste la partida en otro lado», y era falso. El aviso tiene que llegar ANTES del cierre:
  // un mensaje encolado detrás del `close` no lo lee nadie.
  it("si alguien no ocupa su asiento a tiempo, avisa SEATING_TIMEOUT al que entró, cierra sin cobrar y sale abortada", async () => {
    const enqueue = vi.spyOn(matchResults, "enqueue");
    const room = await server.createRoom("domino", {
      mode: "CASUAL",
      matchId: "m-plazo",
      gameModeId: CASUAL_2P.uuid,
      gameMode: CASUAL_2P.gameMode,
      participants: [
        { userId: "t1", displayName: "t1", currency: "VES", providerId: "betaso" },
        { userId: "t2", displayName: "t2", currency: "VES", providerId: "betaso" },
      ],
      seed: "seed",
      teamAssignment: "SEAT_ORDER",
      rateId: "rate-1",
    });
    const present = await joinAs(server, room.roomId, "t1");
    const seen: string[] = [];
    present.onMessage("matchCancelled", (message: { reason: string }) => {
      seen.push(`matchCancelled:${message.reason}`);
    });
    present.onLeave((code: number) => {
      seen.push(`leave:${code}`);
    });

    const key = "m-plazo:aborted";
    await waitUntil(async () => (await matchResults.present([key])).has(key), 8_000);
    await waitUntil(() => seen.some((fact) => fact.startsWith("leave:")));
    expect(seen).toEqual(["matchCancelled:SEATING_TIMEOUT", "leave:4000"]);
    expect(enqueue.mock.calls.find((call) => call[0] === key)?.[2]).toMatchObject({
      reason: "NEVER_STARTED",
    });
    expect(fakeOrchestrator.entries).not.toContain("m-plazo");
    expect(server.getRoomById(room.roomId)).toBeUndefined();
  });

  it("al resolverse, publica el resultado", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    // Destapadas primero: irse con la ventana de reparto abierta ANULA, no resuelve.
    await revealHands(match);
    await act(match, "r1", "ABANDON");
    const key = `${match.config.matchId}:finished`;
    await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
  });

  // LA MESA DE TORNEO NO TOCA DINERO: no pide cobro de entrada, arranca con la mesa completa y su
  // resultado sale con el modo, el torneo y sin montos.
  it("una mesa de torneo arranca sin pedir cobro y publica su resultado con el torneo", async () => {
    const before = fakeOrchestrator.entries.length;
    const enqueue = vi.spyOn(matchResults, "enqueue");
    const room = await server.createRoom("domino", {
      mode: "TOURNAMENT",
      matchId: "m-torneo",
      tournamentId: "t-1",
      participants: [
        { userId: "t1", displayName: "t1", currency: "VES", providerId: "betaso" },
        { userId: "t2", displayName: "t2", currency: "VES", providerId: "betaso" },
      ],
      seed: "seed",
      teamAssignment: "SEAT_ORDER",
      rules: { pointsToWin: 50 },
    });
    const first = await joinAs(server, room.roomId, "t1");
    const second = await joinAs(server, room.roomId, "t2");
    const state = room.state as unknown as {
      phase: string;
      currentRound?: { phase: string };
    };
    await waitUntil(() => state.phase === "PLAYING");
    expect(fakeOrchestrator.entries.length).toBe(before);
    expect(configOfRoom(room.roomId)).toMatchObject({
      mode: "TOURNAMENT",
      tournamentId: "t-1",
      isFreeRoom: true,
      isRematchEnabled: false,
      pointsToWin: 50,
    });

    first.send("REVEAL_TILES", {});
    second.send("REVEAL_TILES", {});
    await waitUntil(() => state.currentRound?.phase === "PLAYING");
    second.send("ABANDON", {});
    const key = "m-torneo:finished";
    await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
    expect(enqueue.mock.calls.find((call) => call[0] === key)?.[2]).toMatchObject({
      mode: "TOURNAMENT",
      tournamentId: "t-1",
      reason: "ABANDONMENT",
      endReason: "ABANDONMENT_VOLUNTARY",
      stakes: {
        currency: "UC",
        entryFee: "0.0000",
        prize: "0.0000",
        isFreeRoom: true,
        bet: null,
      },
      participants: [
        { userId: "t1", result: "won", abandon: null },
        { userId: "t2", result: "abandoned", abandon: "voluntary" },
      ],
    });
  });
});
