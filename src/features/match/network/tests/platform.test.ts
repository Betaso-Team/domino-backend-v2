import {
  type CoreLoopSettle,
  type CoreLoopSettleInput,
  type CoreLoopSettleResult,
  SoftWindowBook,
} from "@/features/core-loop";
import { MemoryLedger, Outbox } from "@/features/economy";
import { DEFAULT_TOURNAMENT_CONFIG, StrikeBook } from "@/features/tournament";
import { MemoryKeyValueStore } from "@/shared/kv";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { FakeWallet } from "@/tests/fake-wallet";
import { describe, expect, it, vi } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { matchConfig } from "../../core/engine/tests/match-config-fixture";
import { RoundState } from "../../core/state";
import type {
  CasualRoomOptions,
  DominoRoomOptions,
  TournamentRoomOptions,
} from "../../transports/match-contract";
import type { NetworkMatchEvent } from "../events";
import { MatchPlatform } from "../platform";
import type { MatchSummary } from "../player-log";

const CASUAL: CasualRoomOptions = {
  mode: "CASUAL",
  gameModeId: "mesa",
  seats: ["u1", "u2"],
  seed: "s",
  pointsToWin: 100,
  entryFee: 10,
  prize: 18,
  rankingWeight: 1,
  isFreeRoom: false,
};

const TOURNAMENT: TournamentRoomOptions = {
  mode: "TOURNAMENT",
  tournamentId: "t1",
  seats: ["u1", "u2"],
  seed: "s",
  pointsToWin: 100,
  pointsPerLoss: 1,
};

const unused = {} as never;

function build(
  options: DominoRoomOptions = CASUAL,
  seats: readonly string[] = ["u1", "u2"],
  coreLoop?: CoreLoopSettle,
) {
  const wallet = new FakeWallet();
  const ledger = new MemoryLedger();
  const log = new MemoryLogger();
  const kv = new MemoryKeyValueStore(() => 0);
  const softWindow = new SoftWindowBook(kv, 60_000);
  const outbox = new Outbox(wallet, ledger, log);
  const summaries: MatchSummary[] = [];
  const platform = new MatchPlatform({
    wallet,
    ledger,
    accounts: unused,
    matchAccounts: unused,
    outbox,
    strikes: new StrikeBook(kv, DEFAULT_TOURNAMENT_CONFIG, () => 0),
    tournamentConfig: DEFAULT_TOURNAMENT_CONFIG,
    summaries: { summarize: (summary) => summaries.push(summary) },
    now: () => 0,
    log,
    ...(coreLoop ? { coreLoop: { client: coreLoop, softWindow, timeoutMs: 50 } } : {}),
  });
  const match = createMatchState(matchConfig([...seats]));
  const sent: { playerId: string; type: string }[] = [];
  const emitted: NetworkMatchEvent[] = [];
  // UNO por mesa, como en la sala: lo que el sink recuerda entre lotes —a quién retiró el
  // sistema— vive en su cierre.
  const sink: (events: readonly NetworkMatchEvent[]) => void = platform.sinkFor(
    options,
    "match-1",
    match,
    (playerId, type) => sent.push({ playerId, type }),
    (events) => emitted.push(...events),
  );
  const penalized = () =>
    sent.filter(({ type }) => type === "TOURNAMENT_PENALTY").map(({ playerId }) => playerId);
  const paid = async () => {
    await outbox.drain();
    return wallet.credited.map(({ playerId, amount }) => ({ playerId, amount }));
  };
  return { wallet, match, sink, penalized, paid, summaries, emitted, softWindow, log };
}

// Deja correr las promesas que el sink dispara: es síncrono a propósito —el motor lo es— y lo
// único que hace es arrancar el trabajo.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("el reembolso de una mesa sin veredicto", () => {
  // ⚠ NO A TODOS: el que se fue habiendo levantado sus fichas pierde la inscripción, como en v1
  // (`two-players/domino-room-state.ts:467-475` filtra a los `quitPlayers` con `isValid`). Los
  // tres casos son los que esa regla distingue — y el tercero es el que una regla escrita por
  // "se fue" en vez de por "se fue HABIENDO VISTO" se equivocaría.
  it.each([
    ["nadie vio y uno se fue", { u1: [true, false] }, ["u1", "u2"]],
    ["el que vio se fue", { u1: [true, true] }, ["u2"]],
    ["el que no vio se fue", { u1: [false, true], u2: [true, false] }, ["u1", "u2"]],
  ] as const)(
    "anulada en el reparto (%s): se devuelve a quien corresponde",
    async (_, state, refunded) => {
      const { wallet, match, sink } = build();
      for (const [playerId, [hasAbandoned, hasSeenTiles]] of Object.entries(state)) {
        const player = match.players.find((candidate) => candidate.playerId === playerId);
        if (player) Object.assign(player, { hasAbandoned, hasSeenTiles });
      }

      sink([{ type: "MATCH_ABORTED", reason: "TILES_NOT_SEEN" }]);
      await settle();

      expect(wallet.refunded).toEqual([{ matchId: "match-1", playerIds: refunded }]);
    },
  );
});

// IRSE DE UNA PARTIDA DE TORNEO CUESTA UN STRIKE, y se distingue QUIÉN dijo el abandono:
//
//   · el SISTEMA, que retira al que se quedó sin tiempo. Su `ABANDON` existe sólo cuando lo dijo
//     el sistema, así que se cobra en el acto — salvo que haya sido la ventana de reparto, que no
//     cuesta nada (v1 no anota strike en `on-timeout-reveal.ts`).
//   · el JUGADOR, con el verbo. Un comando no emite evento, así que se lee del estado al cerrarse
//     la partida: el que abandonó y no fue retirado por el sistema se fue a propósito. Es el
//     `consented` de v1 (`tournaments/game/commands/on-leave.ts:33`).
describe("los strikes de torneo", () => {
  it("el que se va POR SU CUENTA se lleva un strike al cerrarse la partida", async () => {
    const { match, sink, penalized } = build(TOURNAMENT);
    Object.assign(match.players[0] ?? {}, { hasAbandoned: true });

    sink([{ type: "MATCH_RESOLVED", winnerTeamId: "B", reason: "ABANDONMENT" }]);
    await settle();

    expect(penalized()).toEqual(["u1"]);
  });

  it("el retirado por el reloj se lleva UN strike en el acto, y no otro al cerrarse", async () => {
    const { match, sink, penalized } = build(TOURNAMENT);
    Object.assign(match.players[0] ?? {}, { hasAbandoned: true });

    sink([{ type: "ABANDON", playerId: "u1" }]);
    sink([{ type: "MATCH_RESOLVED", winnerTeamId: "B", reason: "ABANDONMENT" }]);
    await settle();

    expect(penalized()).toEqual(["u1"]);
  });

  describe("con la partida anulada en el reparto", () => {
    const abortedAtDeal = () => {
      const built = build(TOURNAMENT);
      built.match.currentRound = new RoundState();
      built.match.currentRound.roundNumber = 1;
      built.match.currentRound.phase = "DEALING";
      return built;
    };

    it("no levantar a tiempo NO cuesta un strike", async () => {
      const { match, sink, penalized } = abortedAtDeal();
      Object.assign(match.players[0] ?? {}, { hasAbandoned: true });

      sink([{ type: "ABANDON", playerId: "u1" }]);
      sink([{ type: "MATCH_ABORTED", reason: "TILES_NOT_SEEN" }]);
      await settle();

      expect(penalized()).toEqual([]);
    });

    it("irse por su cuenta con la ventana abierta SÍ cuesta", async () => {
      const { match, sink, penalized } = abortedAtDeal();
      Object.assign(match.players[1] ?? {}, { hasAbandoned: true });

      sink([{ type: "MATCH_ABORTED", reason: "TILES_NOT_SEEN" }]);
      await settle();

      expect(penalized()).toEqual(["u2"]);
    });
  });

  it("en casual no hay strikes: irse ya cuesta la inscripción", async () => {
    const { match, sink, penalized } = build(CASUAL);
    Object.assign(match.players[0] ?? {}, { hasAbandoned: true });

    sink([{ type: "MATCH_RESOLVED", winnerTeamId: "B", reason: "ABANDONMENT" }]);
    await settle();

    expect(penalized()).toEqual([]);
  });
});

describe("el premio", () => {
  const resolvedFor = (winnerTeamId: "A" | "B") =>
    ({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }) as const;

  it("sin aumento paga el premio de la mesa", async () => {
    const { sink, paid } = build();

    sink([resolvedFor("A")]);

    expect(await paid()).toEqual([{ playerId: "u1", amount: 18 }]);
  });

  // ⚠ EL AUMENTO SE COBRA Y TAMBIÉN SE PAGA. Al aceptar un x3 cada uno pagó dos inscripciones más
  // (`betAmountsOf`); el premio que respaldan es el de la mesa por tres. v1 lo escribe al aceptar
  // (`state.prize = proposal.newPrize`, on-respond-bet-multiplier.ts) y paga ése. Pagar el premio
  // base es quedarse con la diferencia que los dos pusieron.
  it("con un aumento aceptado paga el premio por el nivel", async () => {
    const { match, sink, paid } = build();
    match.acceptedBetLevel = 3;

    sink([resolvedFor("A")]);

    expect(await paid()).toEqual([{ playerId: "u1", amount: 54 }]);
  });

  // LOS BOTS Y LOS RETIRADOS NO COBRAN, la misma regla que `settlementOf`: el asiento que juega la
  // máquina es el del que se fue, y pagarle sería premiar el abandono.
  it("en una mesa de cuatro no le paga a la máquina ni al que se fue", async () => {
    const { match, sink, paid } = build({ ...CASUAL, seats: ["u1", "u2", "u3", "u4"] }, [
      "u1",
      "u2",
      "u3",
      "u4",
    ]);
    Object.assign(match.players[2] ?? {}, { isBot: true });

    sink([resolvedFor("A")]);

    expect(await paid()).toEqual([{ playerId: "u1", amount: 18 }]);
  });

  // LA FILA DICE LO QUE SE PUSO Y LO QUE SE LLEVÓ, así que lleva el aumento: con el base, el
  // historial del jugador mostraría una inscripción que no es la que pagó.
  it("la fila de la partida lleva la inscripción y el premio del aumento", () => {
    const { match, sink, summaries } = build();
    match.acceptedBetLevel = 3;

    sink([resolvedFor("A")]);

    expect(summaries[0]).toMatchObject({ entryFee: 30, prize: 54 });
  });
});

// UN core-loop DE MENTIRA: anota lo que se le pidió y contesta lo que el test le diga. `hang` es el
// backend mudo, que es el caso que el plazo existe para cubrir.
class FakeCoreLoop implements CoreLoopSettle {
  readonly calls: CoreLoopSettleInput[] = [];
  constructor(
    private readonly answer: (
      input: CoreLoopSettleInput,
    ) => readonly Partial<CoreLoopSettleResult>[] | "hang" | "fail" = () => [],
  ) {}

  async settle(input: CoreLoopSettleInput) {
    this.calls.push(input);
    const answer = this.answer(input);
    if (answer === "hang") return new Promise<never>(() => {});
    if (answer === "fail") throw new Error("core-loop caído");
    return {
      enabled: true,
      results: answer.map((result) => ({
        userId: "",
        rakeWaived: false,
        rake0Remaining: 0,
        softWindowRemaining: 0,
        alreadySettled: false,
        ...result,
      })),
    };
  }
}

const waived = (userId: string) => () => [{ userId, rakeWaived: true }];

// CORE-LOOP AL PAGAR: el backend principal decide si esta partida va sin comisión para el ganador, y
// la misma llamada consume el beneficio. Es el v1 del dominó (`two-players/domino-room-state.ts:
// 527-560`, `four-players/:652-700`) con la forma de truco (`pay-winner.ts`, `fa246ad`).
describe("el rake perdonado", () => {
  const resolvedFor = (winnerTeamId: "A" | "B") =>
    ({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }) as const;

  it("al ganador con el rake perdonado le paga el pozo completo", async () => {
    const { sink, paid } = build(CASUAL, ["u1", "u2"], new FakeCoreLoop(waived("u1")));

    sink([resolvedFor("A")]);

    // Pozo = inscripción 10 × 2 jugadores, contra el premio normal de 18.
    await vi.waitFor(async () => expect(await paid()).toEqual([{ playerId: "u1", amount: 20 }]));
  });

  it("el pozo completo lleva el aumento aceptado adentro", async () => {
    const { match, sink, paid } = build(CASUAL, ["u1", "u2"], new FakeCoreLoop(waived("u1")));
    match.acceptedBetLevel = 3;

    sink([resolvedFor("A")]);

    await vi.waitFor(async () => expect(await paid()).toEqual([{ playerId: "u1", amount: 60 }]));
  });

  // ⚠ EL DIVISOR ES NOMINAL (v1, `four-players/domino-room-state.ts:662-666`): la pareja reparte el
  // pozo entre DOS aunque uno se haya ido. Con el divisor real, el que queda cobraría el pozo entero.
  it("en mesa de cuatro reparte el pozo entre los dos de la pareja, aunque uno se haya ido", async () => {
    const seats = ["u1", "u2", "u3", "u4"];
    const { match, sink, paid } = build(
      { ...CASUAL, seats },
      seats,
      new FakeCoreLoop(waived("u1")),
    );
    Object.assign(match.players[2] ?? {}, { hasAbandoned: true });

    sink([resolvedFor("A")]);

    // Pozo = 10 × 4 = 40, entre los 2 nominales: 20 para u1. u3 se fue y no cobra.
    await vi.waitFor(async () => expect(await paid()).toEqual([{ playerId: "u1", amount: 20 }]));
  });

  it("sin perdón de rake paga el premio normal", async () => {
    const { sink, paid } = build(CASUAL, ["u1", "u2"], new FakeCoreLoop());

    sink([resolvedFor("A")]);

    await vi.waitFor(async () => expect(await paid()).toEqual([{ playerId: "u1", amount: 18 }]));
  });

  // FALLA CERRADO: el beneficio es accesorio, el pago no. Un core-loop caído o mudo cuesta el rake
  // normal, nunca dejar al ganador sin cobrar.
  it.each(["fail", "hang"] as const)(
    "si core-loop no contesta (%s), paga el premio normal",
    async (mode) => {
      const { sink, paid } = build(CASUAL, ["u1", "u2"], new FakeCoreLoop(() => mode));

      sink([resolvedFor("A")]);

      await vi.waitFor(async () => expect(await paid()).toEqual([{ playerId: "u1", amount: 18 }]));
    },
  );

  // SE LLAMA SIEMPRE y sin máquinas: también en mesas gratis, porque la ventana blanda cuenta todas
  // las partidas; cada uno con su `won`, y agrupados por la moneda CONGELADA de cada asiento, que el
  // contrato pide de a una por llamada.
  it("liquida a todos los humanos, por moneda, diciendo si la mesa era paga", async () => {
    const seats = ["u1", "u2", "u3", "u4"];
    const coreLoop = new FakeCoreLoop();
    const { match, sink } = build({ ...CASUAL, seats, isFreeRoom: true }, seats, coreLoop);
    Object.assign(match.players[0] ?? {}, { currency: "VES" });
    Object.assign(match.players[1] ?? {}, { currency: "USD" });
    Object.assign(match.players[2] ?? {}, { currency: "VES" });
    Object.assign(match.players[3] ?? {}, { isBot: true });

    sink([resolvedFor("A")]);

    await vi.waitFor(() => expect(coreLoop.calls).toHaveLength(2));
    const usd = coreLoop.calls.find((call) => call.currency === "USD");
    const ves = coreLoop.calls.find((call) => call.currency === "VES");
    expect(usd).toMatchObject({ matchId: "match-1", paid: false });
    expect(usd?.participants).toEqual([{ userId: "u2", won: false }]);
    expect(ves?.participants).toEqual([
      { userId: "u1", won: true },
      { userId: "u3", won: true },
    ]);
  });

  it("anota la ventana blanda de cada uno con lo que contestó core-loop", async () => {
    const { sink, softWindow } = build(
      CASUAL,
      ["u1", "u2"],
      new FakeCoreLoop(() => [
        { userId: "u1", softWindowRemaining: 3 },
        { userId: "u2", softWindowRemaining: 0 },
      ]),
    );

    sink([resolvedFor("A")]);

    await vi.waitFor(async () => expect(await softWindow.remainingFor("u1")).toBe(3));
    expect(await softWindow.remainingFor("u2")).toBe(0);
  });

  // v1: si alguno de los dos sigue en su ventana de novato, la pareja se veta un rato
  // (`PairVetoService.registerVetoIfSoftWindow`): el beneficio no puede ser la forma de que dos
  // cuentas se crucen una y otra vez mientras una de ellas no paga comisión.
  it("si alguno sigue en la ventana blanda, la pareja queda vetada", async () => {
    const { sink, emitted } = build(
      CASUAL,
      ["u1", "u2"],
      new FakeCoreLoop(() => [{ userId: "u2", softWindowRemaining: 4 }]),
    );

    sink([resolvedFor("A")]);

    await vi.waitFor(() =>
      expect(emitted).toContainEqual({ type: "CASUAL_PAIR_VETOED", playerIds: ["u1", "u2"] }),
    );
  });

  it("si nadie está en la ventana, no veta", async () => {
    const coreLoop = new FakeCoreLoop(() => [{ userId: "u1" }, { userId: "u2" }]);
    const { sink, emitted, paid } = build(CASUAL, ["u1", "u2"], coreLoop);

    sink([resolvedFor("A")]);

    await vi.waitFor(async () => expect(await paid()).toHaveLength(1));
    expect(emitted).toEqual([]);
  });
});
