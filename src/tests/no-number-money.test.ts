import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// LA PLATA NUNCA ES UN `number` (la regla de `packages/money` del orquestador, y su test
// `no-number-money` en cada app): adentro es el `Decimal` de billing (`@/shared/money`), en el cable y
// en Mongo texto decimal. Un campo con nombre de plata tipado `number` es un flotante esperando
// desviarse: `0.02 + 0.02 × 5` es `0.12000000000000001`, y ése fue el premio que el orquestador no
// reconoció y mandó a la DLQ.
//
// Recorre `src/` sin los tests (`tests/`, `*.test.ts`) ni `dist`, y salta los comentarios. Un campo que
// se llame como plata y sea una cuenta de verdad se renombra, o entra en `ALLOWED` con su razón.
const NUMBER_MONEY_FIELD =
  /\b(entryFee|prize|amount[A-Za-z]*|stake[A-Za-z]*|pot|fee[A-Za-z]*|balance[A-Za-z]*|refund[A-Za-z]*|vat[A-Za-z]*|additionalEntryFee|additionalPrize|[A-Za-z]*InUC)\??:\s*(readonly\s+)?number\b/;

/** `archivo:línea` → por qué no es plata. Vacío: hoy no hay ninguna excepción. */
const ALLOWED: Readonly<Record<string, string>> = {};

const SRC = fileURLToPath(new URL("..", import.meta.url));

function numberMoneyFields(dir: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) {
        if (name !== "node_modules" && name !== "tests" && name !== "dist") walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || /\.(test|spec)\.ts$/.test(name) || name.endsWith(".d.ts")) {
        continue;
      }
      const file = relative(dir, full);
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const at = `${file}:${index + 1}`;
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || ALLOWED[at] !== undefined) return;
          if (NUMBER_MONEY_FIELD.test(line)) found.push(`${at}  ${line.trim()}`);
        });
    }
  };
  walk(dir);
  return found;
}

describe("la plata nunca es un number", () => {
  it("ningún archivo de src/ tipa un campo de plata como number", () => {
    expect(numberMoneyFields(SRC)).toEqual([]);
  });

  // EL GUARDARRAÍL TIENE QUE MORDER: si la expresión dejara de reconocer un campo, el test de arriba
  // quedaría verde sin proteger nada.
  it.each([
    "  readonly entryFee: number;",
    "  prize?: number,",
    "  amount: readonly number",
    "  readonly additionalEntryFee: number;",
    "  readonly chargedInUC: number;",
    "  stakes: number;",
  ])("reconoce %j", (line) => {
    expect(NUMBER_MONEY_FIELD.test(line)).toBe(true);
  });

  it.each(["  readonly entryFee: Decimal;", "  readonly level: number;", "  extra: number,"])(
    "deja pasar %j",
    (line) => {
      expect(NUMBER_MONEY_FIELD.test(line)).toBe(false);
    },
  );
});
