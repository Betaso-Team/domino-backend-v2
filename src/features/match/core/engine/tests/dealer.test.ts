import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG } from "../../config";
import { DOMINO_SET_SIZE, handValue, sameTile } from "../../rules/tiles";
import { BoardState, BoneyardState, RoundState, Tile } from "../../state";
import { type DealPreset, Dealer, NO_DEAL_PRESET } from "../dealer";
import { createMatchState } from "../genesis";
import { handOf } from "../state-projections";
import { matchConfig } from "./match-config-fixture";

function build(seed = "seed-1") {
  const config = matchConfig(["u1", "u2"], { seed, teamAssignment: "SHUFFLED" });
  const match = createMatchState(config);
  const round = new RoundState();
  round.roundNumber = 1;
  round.board = new BoardState();
  round.boneyard = new BoneyardState();
  match.currentRound = round;

  return { match, dealer: new Dealer(match, config, DEFAULT_GLOBAL_CONFIG) };
}

const tilesOf = (match: ReturnType<typeof build>["match"], playerId: string) => [
  ...handOf(playerId, match).tiles,
];

describe("Dealer", () => {
  it("da 7 fichas a cada jugador y el resto al pozo", () => {
    const { match, dealer } = build();
    dealer.deal(1);

    expect(tilesOf(match, "u1")).toHaveLength(7);
    expect(tilesOf(match, "u2")).toHaveLength(7);
    expect(match.currentRound?.boneyard?.tiles.length).toBe(DOMINO_SET_SIZE - 14);
    expect(match.currentRound?.boneyard?.count).toBe(DOMINO_SET_SIZE - 14);
  });

  it("mantiene tileCount al día, que es el campo que ve el rival", () => {
    const { match, dealer } = build();
    dealer.deal(1);
    for (const player of match.players) expect(player.hand.tileCount).toBe(7);
  });

  it("reparte las 28 fichas sin repetir ninguna", () => {
    const { match, dealer } = build();
    dealer.deal(1);
    const all = [
      ...tilesOf(match, "u1"),
      ...tilesOf(match, "u2"),
      ...(match.currentRound?.boneyard?.tiles ?? []),
    ];
    expect(all).toHaveLength(DOMINO_SET_SIZE);
    for (const tile of all) {
      expect(all.filter((other) => sameTile(tile, other))).toHaveLength(1);
    }
    expect(handValue(all)).toBe(168);
  });

  it("la misma semilla y ronda dan el mismo reparto", () => {
    const a = build("igual");
    const b = build("igual");
    a.dealer.deal(1);
    b.dealer.deal(1);
    expect(tilesOf(a.match, "u1").map((tile) => tile.toJSON())).toEqual(
      tilesOf(b.match, "u1").map((tile) => tile.toJSON()),
    );
  });

  it("distinta ronda da distinto reparto con la misma semilla", () => {
    const a = build("igual");
    const b = build("igual");
    a.dealer.deal(1);
    b.dealer.deal(2);
    expect(tilesOf(a.match, "u1").map((tile) => tile.toJSON())).not.toEqual(
      tilesOf(b.match, "u1").map((tile) => tile.toJSON()),
    );
  });

  it("distinta semilla da distinto reparto", () => {
    const a = build("uno");
    const b = build("dos");
    a.dealer.deal(1);
    b.dealer.deal(1);
    expect(tilesOf(a.match, "u1").map((tile) => tile.toJSON())).not.toEqual(
      tilesOf(b.match, "u1").map((tile) => tile.toJSON()),
    );
  });

  it("reparte sin revelar: nadie levantó nada todavía", () => {
    const { match, dealer } = build();
    dealer.deal(1);

    for (const player of match.players) {
      expect(player.hand.tiles.length).toBe(7);
      expect(player.hasSeenTiles).toBe(false);
    }
  });

  it("repartir dos veces reemplaza la mano, no la acumula", () => {
    const { match, dealer } = build();
    dealer.deal(1);
    dealer.deal(2);
    expect(tilesOf(match, "u1")).toHaveLength(7);
  });

  it("el seam de test permite forzar el orden del mazo", () => {
    class Fixed extends Dealer {
      protected override orderedTiles(): Tile[] {
        const tile = new Tile();
        tile.left = 6;
        tile.right = 6;
        return [tile];
      }
    }
    expect(Fixed.prototype).toBeInstanceOf(Dealer);
  });
});

// EL REPARTO PREPARADO, sólo para probar a mano en local y dev (truco `d6e3219`). Lo que tiene que
// valer es lo mismo que sin preparar —siete por asiento, las 28 sin repetir— más las fichas pedidas
// en la mano pedida, en TODAS las rondas.
describe("Dealer con reparto preparado", () => {
  const prepared = (preset: DealPreset, seed = "seed-1") => {
    const built = build(seed);
    const config = matchConfig(["u1", "u2"], { seed, teamAssignment: "SHUFFLED" });
    return { ...built, dealer: new Dealer(built.match, config, DEFAULT_GLOBAL_CONFIG, preset) };
  };
  const has = (tiles: readonly Tile[], left: number, right: number) =>
    tiles.some((tile) => sameTile(tile, { left, right }));

  it("cada asiento recibe las fichas pedidas y el resto sale del mazo", () => {
    const { match, dealer } = prepared({
      hands: [
        [
          [6, 6],
          [5, 5],
        ],
        [[0, 0]],
      ],
    });
    dealer.deal(1);

    expect(has(tilesOf(match, "u1"), 6, 6)).toBe(true);
    expect(has(tilesOf(match, "u1"), 5, 5)).toBe(true);
    expect(has(tilesOf(match, "u2"), 0, 0)).toBe(true);
    expect(tilesOf(match, "u1")).toHaveLength(7);
    const all = [
      ...tilesOf(match, "u1"),
      ...tilesOf(match, "u2"),
      ...(match.currentRound?.boneyard?.tiles ?? []),
    ];
    expect(all).toHaveLength(DOMINO_SET_SIZE);
    expect(handValue(all)).toBe(168);
  });

  it("vale para todas las rondas", () => {
    const { match, dealer } = prepared({ hands: [[[6, 6]]] });

    dealer.deal(2);

    expect(has(tilesOf(match, "u1"), 6, 6)).toBe(true);
  });

  it("vacío reparte exactamente lo mismo que sin preparar", () => {
    const plain = build("igual");
    const empty = prepared(NO_DEAL_PRESET, "igual");
    plain.dealer.deal(1);
    empty.dealer.deal(1);

    const pips = (match: ReturnType<typeof build>["match"]) =>
      tilesOf(match, "u1").map(({ left, right }) => [left, right]);
    expect(pips(empty.match)).toEqual(pips(plain.match));
  });
});
