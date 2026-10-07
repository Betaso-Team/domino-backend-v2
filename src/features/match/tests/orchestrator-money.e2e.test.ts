import { matchResults, rootContainer } from "@/di-container";
import type { Logger } from "@/shared/logger";
import { joinAs } from "@/tests/e2e";
import { fakeOrchestrator } from "@/tests/fake-orchestrator";
import { CASUAL_2P } from "@/tests/game-mode-catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DominoMatchConfig } from "../core/config";
import {
  ChargeRejectedError,
  OrchestratorBetCharger,
  type OrchestratorCharges,
} from "../network/orchestrator-charges";
import { act, bootServer, clientOf, revealHands, seatPair, waitUntil } from "./e2e-harness";

const PORT = 2607;

// UNA MESA NO MUEVE PLATA EN DOMINÓ: dice qué pasó y pide que se cobre. El resultado va al outbox de
// `betaso_games` y la entrada y el aumento se le piden cobrar al orquestador.
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

  it("un aumento acordado se le pide cobrar al orquestador, y si no cobra se anula", async () => {
    chargeBet.mockImplementation(async () =>
      Promise.reject(new ChargeRejectedError("INSUFFICIENT_FUNDS")),
    );
    const match = await seatPair(server, ["b1", "b2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);

    clientOf(match, "b1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => match.serverState.currentRound?.betOffer !== undefined);
    clientOf(match, "b2").send("RESPOND_BET_MULTIPLIER", { accept: true });

    await waitUntil(() => chargeBet.mock.calls.length === 1);
    expect(chargeBet).toHaveBeenCalledWith(match.config.matchId, 0, 2);
    // ANULADO: el estado vuelve a x1 y el cupo de "uno por partida" queda libre.
    await waitUntil(() => match.serverState.acceptedBetLevel === 0);
  });

  it("un aumento cobrado queda en la mesa", async () => {
    const match = await seatPair(server, ["c1", "c2"], undefined, { betLevels: [...LEVELS] });
    await revealHands(match);

    clientOf(match, "c1").send("PROPOSE_BET_MULTIPLIER", { level: 2 });
    await waitUntil(() => match.serverState.currentRound?.betOffer !== undefined);
    clientOf(match, "c2").send("RESPOND_BET_MULTIPLIER", { accept: true });

    await waitUntil(() => chargeBet.mock.calls.length === 1);
    await new Promise((resume) => setTimeout(resume, 20));
    expect(match.serverState.acceptedBetLevel).toBe(2);
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
    fakeOrchestrator.failEntryWith(async () =>
      Promise.reject(new ChargeRejectedError("INSUFFICIENT_FUNDS")),
    );
    try {
      const match = await seatPair(server, ["x1", "x2"]);
      const key = `${match.config.matchId}:aborted`;
      await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
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
      participants: [
        { userId: "s1", displayName: "s1", currency: "VES" },
        { userId: "s2", displayName: "s2", currency: "VES" },
      ],
      seed: "seed",
      teamAssignment: "SEAT_ORDER",
      rateId: "rate-1",
    });
    await joinAs(server, room.roomId, "s1");
    await new Promise((resume) => setTimeout(resume, 20));
    expect(fakeOrchestrator.entries.length).toBe(before);
  });

  it("al resolverse, publica el resultado", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    // Destapadas primero: irse con la ventana de reparto abierta ANULA, no resuelve.
    await revealHands(match);
    await act(match, "r1", "ABANDON");
    const key = `${match.config.matchId}:finished`;
    await waitUntil(async () => (await matchResults.present([key])).has(key), 3_000);
  });
});
