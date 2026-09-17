import type { PlayerId } from "../../ids.js";
import { DOMINO_MAX_PIP, type TileLike, isDouble, tileValue } from "../../rules/tiles.js";
import { InvariantViolationError } from "../errors.js";

export interface SeatHand {
  readonly playerId: PlayerId;
  readonly tiles: readonly TileLike[];
}

// Reglas §3.2. El orden de la lista ES el orden de los asientos, y eso desempata:
// sin un desempate determinista, dos repartos idénticos podrían arrancar distinto y
// el replay dejaría de reproducir.
export function firstPlayerOf(hands: readonly SeatHand[]): PlayerId {
  if (hands.length === 0) throw new InvariantViolationError("no hay manos que comparar");

  const withMaxDouble = hands.find((hand) =>
    hand.tiles.some((tile) => isDouble(tile) && tile.left === DOMINO_MAX_PIP),
  );
  if (withMaxDouble) return withMaxDouble.playerId;

  let best = hands[0] as SeatHand;
  let bestValue = maxTileValueOf(best);
  for (const hand of hands.slice(1)) {
    const value = maxTileValueOf(hand);
    if (value > bestValue) {
      best = hand;
      bestValue = value;
    }
  }
  return best.playerId;
}

function maxTileValueOf(hand: SeatHand): number {
  return hand.tiles.reduce((max, tile) => Math.max(max, tileValue(tile)), -1);
}
