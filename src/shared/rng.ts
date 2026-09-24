// src/shared/rng.ts
// Portable entre proyectos: no sabe de dominó. Vive en shared/ por eso.

// FNV-1a de 32 bits sobre `${seed}:${round}`. Determinista y sin dependencias.
export function hashSeed(seed: string, round: number): number {
  const input = `${seed}:${round}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// PRNG sin estado compartido: cada llamada a mulberry32 devuelve una secuencia
// nueva desde su semilla. Es lo que hace cada ronda reproducible AISLADA.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Fisher-Yates sobre una copia.
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = result[index] as T;
    result[index] = result[swap] as T;
    result[swap] = held;
  }
  return result;
}
