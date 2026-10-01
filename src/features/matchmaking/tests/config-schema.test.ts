import { describe, expect, it } from "vitest";
import { DEFAULT_MATCHMAKING_CONFIG } from "../config";
import {
  MATCHMAKING_EDITABLE,
  MATCHMAKING_NOT_EDITABLE,
  matchmakingConfigPatch,
} from "../config-schema";

describe("El parche de la configuración del emparejamiento", () => {
  it("acepta un campo solo", () => {
    expect(matchmakingConfigPatch.safeParse({ searchTimeoutMs: 90_000 }).success).toBe(true);
  });

  it("rechaza el número que satura el timer de Node y vacía la cola de golpe", () => {
    expect(matchmakingConfigPatch.safeParse({ searchTimeoutMs: 9_999_999_999 }).success).toBe(
      false,
    );
  });

  // Las cotas de v1 (`TIMEOUT_LIMITS.MATCHMAKING`): de 30 s a 10 minutos.
  it("la búsqueda respeta las cotas de v1", () => {
    expect(matchmakingConfigPatch.safeParse({ searchTimeoutMs: 29_999 }).success).toBe(false);
    expect(matchmakingConfigPatch.safeParse({ searchTimeoutMs: 600_001 }).success).toBe(false);
  });

  // Los tres que el proceso lee al arrancar. Rechazarlos es el punto entero: aceptados, serían un
  // cambio que nunca pasa y del que nadie se entera.
  it.each(MATCHMAKING_NOT_EDITABLE)("rechaza %s, que se lee al arrancar", (field) => {
    expect(matchmakingConfigPatch.safeParse({ [field]: 1000 }).success).toBe(false);
  });

  it("todo campo de la configuración tiene cota o está declarado no editable", () => {
    const covered = new Set<string>([...MATCHMAKING_EDITABLE, ...MATCHMAKING_NOT_EDITABLE]);

    expect([...covered].sort()).toEqual(Object.keys(DEFAULT_MATCHMAKING_CONFIG).sort());
  });
});
