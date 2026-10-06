// EL POZO COMPLETO: lo que se lleva un ganador cuando core-loop le perdona el rake de esta partida —
// el premio sin la comisión de la casa—. Pura y agnóstica del aumento de apuesta: quien llama ya
// escaló `entryFee` y `prizePerWinner` por el nivel aceptado, igual que escala el premio normal.
//
// ⚠ EL DIVISOR ES NOMINAL y no los cobradores reales, y es la regla de v1 para la mesa de cuatro
// (`four-players/domino-room-state.ts:662-666`): si un socio abandonó, el que queda cobra SU mitad
// del pozo y la otra mitad se queda en la casa — igual que hoy se queda el `prize` del ausente. Con
// el divisor por cobradores reales, un abandono le pagaría el pozo entero a uno solo.

export interface FullPotInput {
  readonly entryFee: number;
  readonly prizePerWinner: number;
  readonly playersQuantity: number;
  /** Los asientos de la pareja que ganó: 1 en 2P, 2 en 4P. */
  readonly nominalWinners: number;
}

export interface FullPotResult {
  readonly amountPerWinner: number;
  /**
   * `true` cuando el pozo por ganador salió menor o igual al premio normal: las entradas no
   * significan lo que la fórmula asume. `amountPerWinner` cae al `prizePerWinner` —nunca menos de lo
   * que se pagaría sin el beneficio— y quien llama lo grita en el log.
   */
  readonly formulaBroken: boolean;
}

export function fullPotFor(input: FullPotInput): FullPotResult {
  const { entryFee, prizePerWinner, playersQuantity, nominalWinners } = input;
  const amountPerWinner =
    nominalWinners > 0 ? (entryFee * playersQuantity) / nominalWinners : Number.NaN;

  if (!Number.isFinite(amountPerWinner) || amountPerWinner <= prizePerWinner)
    return { amountPerWinner: prizePerWinner, formulaBroken: true };

  return { amountPerWinner, formulaBroken: false };
}
