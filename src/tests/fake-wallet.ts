// LA BILLETERA FALSA de la suite.
//
// VIVE EN `src/tests/` Y NO EN SU FEATURE, y es la Regla 4 la que lo decide: `feature-boundary`
// prohibe que una feature importe archivos internos de otra, y `features/matchmaking/tests/
// pools.test.ts` lo consume —el pool casual necesita las dos cosas para poder admitir a alguien—.
// Es el mismo motivo por el que `game-mode-catalog.ts` está acá: un archivo fuera de
// `src/features/` es el único lugar del que dos features pueden tirar.
//
// La alternativa —exportarlo por el `index.ts` de su feature, que la Regla 4 sí permite— metría
// un doble en la superficie pública, que es de donde nadie lo puede podar después.

import {
  type AffordQuery,
  InsufficientFundsError,
  type Movement,
  type WalletPort,
  WalletUnavailableError,
} from "@/features/economy/wallet";

// The suite's wallet: in memory, it records what it is asked for and always succeeds.
//
// It records instead of merely returning nothing because the tests assert on that: what was charged,
// to whom and why. Without the record, a casual match E2E could not tell "charged correctly" from
// "did nothing".
export class FakeWallet implements WalletPort {
  readonly charged: Movement[] = [];
  readonly credited: Movement[] = [];
  readonly refunded: Array<{ matchId: string; playerIds: readonly string[] }> = [];
  readonly refundedMovements: Movement[] = [];

  // Balances per player, in account units. Absent means plenty: a test that does not talk about money
  // should not have to declare it.
  private readonly balances = new Map<string, number>();
  // Provoked failures, so the sad path can be tested without touching the implementation.
  private failing = false;

  setBalance(playerId: string, amount: number): void {
    this.balances.set(playerId, amount);
  }

  // Named for persistence and not for one use: the failure LASTS until it is reverted.
  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  async canAfford({ playerId, amount }: AffordQuery): Promise<boolean> {
    if (this.failing) throw new WalletUnavailableError("fake");
    const balance = this.balances.get(playerId);
    // An undeclared balance means plenty, as in the charge: a test that does not talk about money
    // should not have to declare it for its player to get in.
    return balance === undefined || balance >= amount;
  }

  async charge(movement: Movement): Promise<void> {
    if (this.failing) throw new WalletUnavailableError("fake");
    const balance = this.balances.get(movement.playerId);
    if (balance !== undefined) {
      if (balance < movement.amount) throw new InsufficientFundsError(movement.playerId);
      this.balances.set(movement.playerId, balance - movement.amount);
    }
    this.charged.push(movement);
  }

  async credit(movement: Movement): Promise<void> {
    if (this.failing) throw new WalletUnavailableError("fake");
    const balance = this.balances.get(movement.playerId);
    if (balance !== undefined) this.balances.set(movement.playerId, balance + movement.amount);
    this.credited.push(movement);
  }

  async refund(movement: Movement): Promise<void> {
    if (this.failing) throw new WalletUnavailableError("fake");
    const balance = this.balances.get(movement.playerId);
    if (balance !== undefined) this.balances.set(movement.playerId, balance + movement.amount);
    this.refundedMovements.push(movement);
  }

  async refundMatch(matchId: string, playerIds: readonly string[]): Promise<void> {
    if (this.failing) throw new WalletUnavailableError("fake");
    this.refunded.push({ matchId, playerIds });
  }

  balanceOf(playerId: string): number | undefined {
    return this.balances.get(playerId);
  }
}
