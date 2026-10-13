import { hashSeed, mulberry32, shuffled } from "@/shared/rng";
import { type DominoMatchConfig, type GlobalDominoConfig, playerIdsOf } from "../config";
import { orderedTileSet, sameTile } from "../rules/tiles";
import { Tile } from "../state";
import type { MatchState } from "../state";
import { boneyardOf, currentRoundOf, playerOf } from "./state-projections";

// Repartir no revela: Dealer no recibe el puerto de visibilidad. La única fuente de
// aleatoriedad se deriva de (seed, roundNumber), sin estado compartido entre rondas.
/**
 * UN REPARTO PREPARADO, sólo para probar a mano en local y dev: las fichas que cada asiento recibe
 * sí o sí, en orden de asiento. Lo que no se pide sale del mazo barajado como siempre, y vale para
 * TODAS las rondas. Nunca existe en stage ni en prod: lo cablea el composition root sólo ahí.
 *
 * ⚠ El replay rebobina con la semilla y no con el preset, así que una partida jugada con uno
 * preparado no se reconstruye igual. Es una herramienta de prueba, no una partida que se audite.
 */
export interface DealPreset {
  readonly hands: readonly (readonly (readonly [number, number])[])[];
}

export const NO_DEAL_PRESET: DealPreset = { hands: [] };

export class Dealer {
  constructor(
    private readonly match: MatchState,
    private readonly config: DominoMatchConfig,
    private readonly globalConfig: GlobalDominoConfig,
    private readonly preset: DealPreset = NO_DEAL_PRESET,
  ) {}

  deal(roundNumber: number): void {
    const round = currentRoundOf(this.match);
    const shuffledDeck = shuffled(
      this.orderedTiles(),
      mulberry32(hashSeed(this.config.seed, roundNumber)),
    );
    // LO PEDIDO SE SACA DEL MAZO antes de repartir el resto, así que sin preset el mazo es el mismo
    // de siempre y el reparto sale idéntico al que no se preparó.
    const reserved = this.preset.hands.flat();
    const isReserved = (tile: Tile) =>
      reserved.some(([left, right]) => sameTile(tile, { left, right }));
    const deck = shuffledDeck.filter((tile) => !isReserved(tile));

    let cursor = 0;
    playerIdsOf(this.config).forEach((playerId, seatIndex) => {
      const hand = playerOf(playerId, this.match).hand;
      hand.tiles.clear();
      for (const [left, right] of this.preset.hands[seatIndex] ?? []) {
        const tile = shuffledDeck.find((candidate) => sameTile(candidate, { left, right }));
        if (tile) hand.tiles.push(tile);
      }
      while (hand.tiles.length < this.globalConfig.tilesPerPlayer) {
        const tile = deck[cursor];
        cursor += 1;
        if (!tile) break;
        hand.tiles.push(tile);
      }
      hand.tileCount = hand.tiles.length;
      hand.isRevealed = false;
    });

    if (round.boneyard) {
      const boneyard = boneyardOf(round);
      boneyard.tiles.clear();
      for (const tile of deck.slice(cursor)) boneyard.tiles.push(tile);
      boneyard.count = boneyard.tiles.length;
    }
  }

  protected orderedTiles(): Tile[] {
    return orderedTileSet().map(([left, right]) => {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      return tile;
    });
  }
}
