import { describe, expect, it } from "vitest";
import { MATCH_EDITABLE, MATCH_NOT_EDITABLE, matchConfigPatch } from "./config-schema";
import { DEFAULT_GLOBAL_CONFIG } from "./core/config";

// LAS COTAS SON EL PUNTO de exponer la config: lo que se edita desde afuera es lo que corre toda mesa
// del clúster unos segundos después, y no hay un deploy en el medio que ataje un cero.

describe("El parche de la configuración global del dominó", () => {
  it("acepta un campo solo, que es lo que lo hace un parche", () => {
    expect(matchConfigPatch.safeParse({ presentingRoundMs: 6000 }).success).toBe(true);
  });

  it("rechaza el cero, que es el plazo ya vencido que despierta en bucle", () => {
    expect(matchConfigPatch.safeParse({ presentingRoundMs: 0 }).success).toBe(false);
  });

  it("rechaza lo que el reloj de la sala no haría esperar sino congelar", () => {
    expect(matchConfigPatch.safeParse({ turnTimeoutMs: 9_999_999_999 }).success).toBe(false);
  });

  // Las cotas de v1 (`TIMEOUT_LIMITS`), donde v1 las tiene: el turno va de 15 a 300 s.
  it("el turno respeta las cotas de v1", () => {
    expect(matchConfigPatch.safeParse({ turnTimeoutMs: 14_999 }).success).toBe(false);
    expect(matchConfigPatch.safeParse({ turnTimeoutMs: 15_000 }).success).toBe(true);
    expect(matchConfigPatch.safeParse({ turnTimeoutMs: 300_001 }).success).toBe(false);
  });

  it("rechaza una clave desconocida en vez de ignorarla", () => {
    expect(matchConfigPatch.safeParse({ presentinRoundMs: 6000 }).success).toBe(false);
  });

  // Es regla de juego y no un plazo: con cuatro jugadores las 28 fichas se reparten enteras, y un
  // número distinto rompe el pozo o el reparto a mitad de un clúster.
  it("no deja editar las fichas por jugador", () => {
    expect(matchConfigPatch.safeParse({ tilesPerPlayer: 5 }).success).toBe(false);
  });

  // EL GUARDARRAÍL CONTRA LA DERIVA: un campo agregado a la config y a ninguna cota viajaría
  // editable sin piso o —peor— no viajaría y nadie se enteraría.
  it("todo campo de la configuración tiene cota o está declarado no editable", () => {
    const covered = new Set<string>([...MATCH_EDITABLE, ...MATCH_NOT_EDITABLE]);

    expect([...covered].sort()).toEqual(Object.keys(DEFAULT_GLOBAL_CONFIG).sort());
  });

  // Los defaults de fábrica tienen que ser un parche válido: si no, la cota está mal puesta y el
  // panel no podría volver a escribir el valor con el que el juego sale.
  it("los defaults de fábrica pasan sus propias cotas", () => {
    const editable = Object.fromEntries(
      MATCH_EDITABLE.map((key) => [
        key,
        DEFAULT_GLOBAL_CONFIG[key as keyof typeof DEFAULT_GLOBAL_CONFIG],
      ]),
    );

    expect(matchConfigPatch.safeParse(editable).success).toBe(true);
  });
});
