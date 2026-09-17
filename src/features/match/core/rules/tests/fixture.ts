import type { PlayerId } from "../../ids.js";
import type { BoardSide } from "../board-ends.js";
import type { BetLevel, DominoRulesConfig } from "../config.js";
import type { MatchPhase, RoundPhase } from "../phases.js";
import type { TileLike } from "../tiles.js";
import type { MatchView, PlayerView, RoundView } from "../view.js";

// LA MESA COMO OBJETO PLANO, y ése es el test.
//
// Estas reglas se prueban SIN construir un solo nodo de Colyseus: literales de TS que satisfacen
// `MatchView` por estructura. Que compile es la mitad de la afirmación que el módulo hace —"esto
// lo puede correr el cliente"—, y es la mitad que ningún `expect` podría comprobar.
//
// El fixture del motor (`engine/round/tests/round-fixture.ts`) sigue existiendo y hace lo
// contrario a propósito: arma el árbol de verdad, porque lo que prueba son mutaciones.

export interface ViewSetup {
  /** Las manos, por asiento. El orden de las claves es el orden de los asientos. */
  readonly hands: Record<PlayerId, [number, number][]>;
  readonly board?: [number, number, BoardSide][];
  readonly boneyardCount?: number;
  /** Ausente: le toca al primer asiento. */
  readonly turn?: PlayerId;
  readonly roundPhase?: RoundPhase;
  readonly matchPhase?: MatchPhase;
  /** `true` borra la ronda: es la mesa que todavía no arrancó, o la que ya cerró. */
  readonly noRound?: boolean;
  readonly seenTiles?: readonly PlayerId[];
  readonly abandoned?: readonly PlayerId[];
  readonly betOffer?: RoundView["betOffer"];
  readonly acceptedBetLevel?: number;
  /** Con quién contesta `privateOf`. Ausente: con todos, que es el servidor. */
  readonly visibleHandsOf?: readonly PlayerId[];
}

const tileOf = ([left, right]: [number, number]): TileLike => ({ left, right });

export function viewOf(setup: ViewSetup): MatchView {
  const seats = Object.keys(setup.hands);
  const players: PlayerView[] = seats.map((playerId, seatIndex) => ({
    playerId,
    teamId: seatIndex % 2 === 0 ? "A" : "B",
    seatIndex,
    connected: true,
    hasAbandoned: setup.abandoned?.includes(playerId) ?? false,
    hasSeenTiles: setup.seenTiles?.includes(playerId) ?? false,
    extraTimeRemainingMs: 30_000,
    hand: {
      tileCount: (setup.hands[playerId] ?? []).length,
      isRevealed: false,
    },
  }));

  const turn = setup.turn ?? seats[0] ?? "";
  const round: RoundView = {
    roundNumber: 1,
    phase: setup.roundPhase ?? "PLAYING",
    starterId: turn,
    board: {
      tiles: (setup.board ?? []).map(([left, right, side]) => ({
        tile: tileOf([left, right]),
        playedBy: seats[0] ?? "",
        side,
      })),
    },
    boneyard: { count: setup.boneyardCount ?? 0 },
    currentTurn: { playerId: turn, isConsumingExtendedTime: false, consecutivePasses: 0 },
    betOffer: setup.betOffer,
  };

  return {
    phase: setup.matchPhase ?? "PLAYING",
    scoreboard: { teamA: 0, teamB: 0 },
    players,
    currentRound: setup.noRound ? undefined : round,
    pastRounds: [],
    pointsToWin: 100,
    activeDeadline: 0,
    startedAt: 0,
    acceptedBetExtra: 0,
    acceptedBetLevel: setup.acceptedBetLevel ?? 0,
    privateOf(playerId) {
      const tiles = setup.hands[playerId];
      if (!tiles) return undefined;
      if (setup.visibleHandsOf && !setup.visibleHandsOf.includes(playerId)) return undefined;
      return { tiles: tiles.map(tileOf) };
    },
  };
}

// Un catálogo de dos niveles, con los números de un modo productivo de v1.
export const BET_LEVELS: readonly BetLevel[] = [
  { level: 1, extra: 1, additionalEntryFee: 10, additionalPrize: 18 },
  { level: 2, extra: 2, additionalEntryFee: 20, additionalPrize: 36 },
];

export const rulesConfig = (overrides: Partial<DominoRulesConfig> = {}): DominoRulesConfig => ({
  betLevels: BET_LEVELS,
  isFreeRoom: false,
  ...overrides,
});
