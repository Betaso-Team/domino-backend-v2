import {
  BoardState,
  BoneyardState,
  type MatchState,
  PlacedTile,
  type RoundPhase,
  RoundState,
  Tile,
  Turn,
} from "../../../state/index";
import type { BoardSide } from "../../../state/tile";
import { createMatchState } from "../../genesis";
import { handOf } from "../../state-projections";
import { matchConfig } from "../../tests/match-config-fixture";

export interface RoundSetup {
  hands: Record<string, [number, number][]>;
  board?: [number, number, BoardSide][];
  boneyard?: [number, number][];
  turn?: string;
  phase?: RoundPhase;
}

function tileOf([left, right]: [number, number]): Tile {
  const tile = new Tile();
  tile.left = left;
  tile.right = right;
  return tile;
}

export function roundState(setup: RoundSetup): MatchState {
  const seats = Object.keys(setup.hands);
  const match = createMatchState(matchConfig(seats, { seed: "s", teamAssignment: "SHUFFLED" }));
  match.phase = "PLAYING";

  const round = new RoundState();
  round.roundNumber = 1;
  round.phase = setup.phase ?? "PLAYING";
  round.board = new BoardState();
  const boneyardState = new BoneyardState();
  round.boneyard = boneyardState;
  round.starterId = setup.turn ?? seats[0] ?? "";

  for (const [left, right, side] of setup.board ?? []) {
    const placed = new PlacedTile();
    placed.tile = tileOf([left, right]);
    placed.playedBy = seats[0] ?? "";
    placed.side = side;
    round.board.tiles.push(placed);
  }
  for (const pair of setup.boneyard ?? []) boneyardState.tiles.push(tileOf(pair));
  boneyardState.count = boneyardState.tiles.length;

  const turn = new Turn();
  turn.playerId = setup.turn ?? seats[0] ?? "";
  turn.isConsumingExtendedTime = false;
  turn.consecutivePasses = 0;
  round.currentTurn = turn;

  match.currentRound = round;

  for (const [playerId, tiles] of Object.entries(setup.hands)) {
    const hand = handOf(playerId, match);
    for (const pair of tiles) hand.tiles.push(tileOf(pair));
    hand.tileCount = hand.tiles.length;
  }
  return match;
}
