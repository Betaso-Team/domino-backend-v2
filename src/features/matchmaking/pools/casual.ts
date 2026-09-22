import type { WalletPort } from "@/features/economy";
import type { GameModeReader } from "@/features/game-mode";
import type { DominoRoomOptions } from "@/features/match";
import { MatchmakingError } from "../errors";
import type { Ticket } from "../pool";
import type { PoolSpec, Requester } from "../pool-spec";

// The CASUAL pool: a table of the catalog. The `poolId` IS the game mode id, so two different tables
// are two different queues even at the same price — the player picked one.

export interface CasualPoolDeps {
  readonly catalog: GameModeReader;
  // The BALANCE only. The queue neither charges nor pays — that belongs to the match — so it asks
  // for the one thing it consults.
  readonly wallet: Pick<WalletPort, "canAfford">;
  // Who they would rather not cross. Filled in by the casual veto.
  readonly avoid: (playerId: string) => Promise<readonly string[]>;
}

export async function casualPoolSpec(gameModeId: string, deps: CasualPoolDeps): Promise<PoolSpec> {
  const table = await deps.catalog.byUuid(gameModeId);
  if (!table) throw new MatchmakingError("POOL_NOT_FOUND", `modo inexistente: ${gameModeId}`);
  if (!table.isActive) throw new MatchmakingError("POOL_CLOSED", `modo inactivo: ${gameModeId}`);

  return {
    poolId: gameModeId,
    seats: table.playersQuantity,
    pointsToWin: table.pointsToWin,

    // The balance is checked BEFORE queueing. It is a query and not a hold: between this and the
    // charge at admission the balance can change, so what decides is still the charge. What is
    // gained here is not dragging the rival in: bouncing someone at admission opens and closes a
    // match the other was already playing.
    async admit({ playerId, token }: Requester): Promise<void> {
      if (table.entryFee <= 0) return;
      // The token travels this far uninterpreted: it is the credential the other side answers with
      // which currency this player is charged in, and this is the FIRST time anyone asks. Everything
      // that comes afterwards — the charge, the prize, the rematch — finds it already resolved.
      if (!(await deps.wallet.canAfford({ playerId, amount: table.entryFee, token })))
        throw new MatchmakingError("INSUFFICIENT_FUNDS");
    },

    avoid: deps.avoid,

    toRoomOptions(group: readonly Ticket[], seed: string): DominoRoomOptions {
      return {
        mode: "CASUAL",
        gameModeId,
        // The ORDER is the one the grouping decided, and that order IS the team assignment.
        // Reordering here would undo a decision already made.
        seats: group.map((t) => t.playerId),
        seed,
        pointsToWin: table.pointsToWin,
        entryFee: table.entryFee,
        prize: table.prize,
        rankingWeight: table.multiplier,
        isFreeRoom: table.isFreeRoom,
      };
    },
  };
}
