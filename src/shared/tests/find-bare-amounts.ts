// COPIA de `packages/money/src/testing.ts` de tablea-gaming-orchestrator, commit 8e9732e
// (`@betaso/money/testing`), con el formato de biome. Es de los tests: ningún código de producción la
// importa.
//
// FOR THE SHAPE TESTS OF EACH APP (`@betaso/money/testing`): a response, webhook or event body run
// through `findBareAmounts` with the keys that carry money must come back empty.

/**
 * The paths (`$.data.items[0].prize`) where a key in `keys` holds a bare string or number instead of a
 * `Money` object. `null` and absent values are not bare: an amount may be optional. The walk goes
 * through every object and array, so a key is checked wherever it appears.
 */
export function findBareAmounts(json: unknown, keys: Iterable<string>): string[] {
  const watched = new Set(keys);
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const at = `${path}.${key}`;
      if (watched.has(key) && (typeof child === "string" || typeof child === "number")) {
        found.push(at);
      }
      walk(child, at);
    }
  };
  walk(json, "$");
  return found;
}
