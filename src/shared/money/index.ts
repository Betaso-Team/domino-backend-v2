// EL DINERO DEL DOMINÓ, copia de `packages/money` de tablea-gaming-orchestrator (commit 85cd1a4): el
// `Decimal` de billing (`decimal.ts`), las fórmulas de la mesa (`pricing.ts`) y la convención de montos
// (`money.ts`). Cada archivo dice en su cabecera qué se copió y qué no.
export {
  MoneyError,
  UC,
  UC_DECIMALS,
  assertDecimal,
  fixed,
  isDecimal,
  readAmount,
  sameAmount,
} from "./money";
export {
  DECIMAL_TEXT,
  Decimal,
  ONE,
  ZERO,
  count,
  decimal,
  fromNumber,
  roundHalfUp,
} from "./decimal";
export { betDifference, stakeAt, toCurrency } from "./pricing";
