import { MemoryLedger, Outbox } from "@/features/economy";
import { DEFAULT_TOURNAMENT_CONFIG, StrikeBook } from "@/features/tournament";
import { MemoryKeyValueStore } from "@/shared/kv";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { FakeWallet } from "@/tests/fake-wallet";
import { describe, expect, it } from "vitest";
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

function build(options: DominoRoomOptions = CASUAL, seats: readonly string[] = ["u1", "u2"]) {
  const wallet = new FakeWallet();
  const ledger = new MemoryLedger();
  const log = new MemoryLogger();
  const kv = new MemoryKeyValueStore(() => 0);
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
  });
  const match = createMatchState(matchConfig([...seats]));
  const sent: { playerId: string; type: string }[] = [];
  // UNO por mesa, como en la sala: lo que el sink recuerda entre lotes —a quién retiró el
  // sistema— vive en su cierre.
  const sink: (events: readonly NetworkMatchEvent[]) => void = platform.sinkFor(
    options,
    "match-1",
    match,
    (playerId, type) => sent.push({ playerId, type }),
  );
  const penalized = () =>
    sent.filter(({ type }) => type === "TOURNAMENT_PENALTY").map(({ playerId }) => playerId);
  const paid = async () => {
    await outbox.drain();
    return wallet.credited.map(({ playerId, amount }) => ({ playerId, amount }));
  };
  return { wallet, match, sink, penalized, paid, summaries };
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
