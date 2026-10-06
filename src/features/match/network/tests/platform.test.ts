import { MemoryLedger } from "@/features/economy";
import { DEFAULT_TOURNAMENT_CONFIG, StrikeBook } from "@/features/tournament";
import { MemoryKeyValueStore } from "@/shared/kv";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { FakeWallet } from "@/tests/fake-wallet";
import { describe, expect, it } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { matchConfig } from "../../core/engine/tests/match-config-fixture";
import type { CasualRoomOptions } from "../../transports/match-contract";
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

const unused = {} as never;

function build() {
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
  const sink = (events: readonly NetworkMatchEvent[]) =>
    platform.sinkFor(CASUAL, "match-1", match, () => {})(events);
  return { wallet, match, sink };
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
