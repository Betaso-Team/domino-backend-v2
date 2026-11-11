// COPIA de `findBadAmounts` en `packages/money/src/testing.ts` de tablea-gaming-orchestrator, commit
// c9222ea (`@betaso/money/testing`), con el formato de biome y sin `findBareAmounts` (la regla de v1). Es
// de los tests: ningún código de producción la importa.
//
// FOR THE SHAPE TESTS OF EACH APP (`@betaso/money/testing`): a response, webhook or event body run
// through `findBadAmounts` with the keys that carry money must come back empty.

import { isDecimal } from "@/shared/money";

/** A key of a v1 money object: a currency code, all lowercase (`ves`, `uc`) or all uppercase (`VES`). */
const CODE_KEY = /^(?:[a-z][a-z0-9]{1,9}|[A-Z][A-Z0-9]{1,9})$/;

/** Whether `value` looks like a v1 money object: code-like keys, each with a decimal string. */
function isMoneyObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 && entries.every(([key, child]) => CODE_KEY.test(key) && isDecimal(child))
  );
}

/** Every `[path, value]` under a key of `keys`, at any depth, in document order. */
function watchedValues(json: unknown, keys: Iterable<string>): Array<[string, unknown]> {
  const watched = new Set(keys);
  const found: Array<[string, unknown]> = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const at = `${path}.${key}`;
      if (watched.has(key)) found.push([at, child]);
      walk(child, at);
    }
  };
  walk(json, "$");
  return found;
}

/**
 * The paths (`$.data.items[0].prize`) where a key in `keys` holds an amount outside the v2 convention:
 *  - a number (`prize: 1000`);
 *  - a string that is not a strict decimal (`prize: '1e3'`, `prize: ''`);
 *  - a v1 money object (`prize: { ves: '1000.00', uc: '10.0000' }`, or `{ VES: '1000.00' }`).
 * `null` and absent values pass: an amount may be optional. A sub-entity under a watched key
 * (`exposureCap: { currency: 'UC', amount: '500.0000' }`) is not a money object, because its
 * `currency` is not a decimal. The walk goes through every object and array, so a key is checked
 * wherever it appears.
 */
export function findBadAmounts(json: unknown, keys: Iterable<string>): string[] {
  return watchedValues(json, keys)
    .filter(
      ([, value]) =>
        typeof value === "number" ||
        (typeof value === "string" && !isDecimal(value)) ||
        isMoneyObject(value),
    )
    .map(([path]) => path);
}
