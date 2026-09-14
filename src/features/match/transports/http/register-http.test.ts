import type { Application as Express } from "express";
import { describe, expect, it } from "vitest";
import { registerInternalHistoryHttp } from "./register-http.js";

// Un doble de Express que solo anota QUÉ rutas se registraron. No hace falta levantar un
// servidor: lo que se mide acá es una decisión de wiring —si la ruta llega a existir—, y
// el comportamiento de la ruta ya lo cubren los tests e2e con la llave puesta.
function pathsRegisteredWith(internalApiKey: string | undefined): string[] {
  const paths: string[] = [];
  const app = { get: (path: string) => paths.push(path) } as unknown as Express;
  registerInternalHistoryHttp(app, internalApiKey);
  return paths;
}

describe("registerInternalHistoryHttp", () => {
  // FAIL CLOSED. La alternativa —registrar igual y comparar contra una llave vacía— deja
  // una ruta interna viva que el operador ve responder y cree protegida.
  it("sin llave interna la ruta de soporte no llega a existir", () => {
    expect(pathsRegisteredWith(undefined)).toEqual([]);
  });

  it("con llave interna la ruta de soporte se registra", () => {
    expect(pathsRegisteredWith("k".repeat(16))).toEqual(["/internal/matches/:matchId/history"]);
  });
});
