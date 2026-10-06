import { MemoryLedger } from "@/features/economy";
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

function build(options: DominoRoomOptions = CASUAL) {
  const wallet = new FakeWallet();
  const kv = new MemoryKeyValueStore(() => 0);
  const platform = new MatchPlatform({
    wallet,
    ledger: new MemoryLedger(),
    accounts: unused,
    matchAccounts: unused,
    strikes: new StrikeBook(kv, DEFAULT_TOURNAMENT_CONFIG, () => 0),
    tournamentConfig: DEFAULT_TOURNAMENT_CONFIG,
    summaries: { summarize: () => {} },
    now: () => 0,
    log: new MemoryLogger(),
  });
  const match = createMatchState(matchConfig(["u1", "u2"]));
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
  return { wallet, match, sink, penalized };
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
