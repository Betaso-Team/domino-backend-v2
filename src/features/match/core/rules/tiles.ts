// Vocabulario del dominó anterior a cualquier fase: qué fichas existen y cuánto vale
// una. Derivación pura, sin estado. Lo consumen el Dealer y el Scorer.

export const DOMINO_MAX_PIP = 6;
export const DOMINO_SET_SIZE = 28;

export interface TileLike {
  readonly left: number;
  readonly right: number;
}

// El doble-seis contiene todas las combinaciones no ordenadas de 0..6. Generarlo
// evita los typos y omisiones posibles en un literal de 28 entradas.
export function orderedTileSet(): ReadonlyArray<readonly [number, number]> {
  const tiles: [number, number][] = [];
  for (let left = 0; left <= DOMINO_MAX_PIP; left += 1) {
    for (let right = left; right <= DOMINO_MAX_PIP; right += 1) {
      tiles.push([left, right]);
    }
  }
  return tiles;
}

export function tileValue(tile: TileLike): number {
  return tile.left + tile.right;
}

export function isDouble(tile: TileLike): boolean {
  return tile.left === tile.right;
}

export function sameTile(a: TileLike, b: TileLike): boolean {
  return (a.left === b.left && a.right === b.right) || (a.left === b.right && a.right === b.left);
}

export function handValue(tiles: readonly TileLike[]): number {
  return tiles.reduce((sum, tile) => sum + tileValue(tile), 0);
}
