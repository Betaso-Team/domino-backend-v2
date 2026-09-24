import type { Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { INTERNAL_KEY_HEADER, requireInternalKey } from "./internal-key";

// LA PUERTA DE LAS RUTAS INTERNAS: la que pide la llave que el orquestador presenta para
// administrar el catálogo, el mantenimiento del lobby y el historial de soporte.
//
// ⚠ ES LA MITAD ENTRANTE, y no se confunde con `features/auth/internal-key.ts`, que es la SALIENTE
// —la llave que NOSOTROS presentamos al backend principal, con otro nombre de header
// (`x-internal-api-key`) porque es otro contrato con otra punta—.
//
// Acá no hay identidad que extraer: la llave no dice QUIÉN habla, dice que el que habla es un
// servidor autorizado. Por eso no cuelga nada de `req` y las rutas que protege no pueden auditar a
// una persona.

function fakeRes() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, sent };
}

// El doble de `req` implementa `get` y no un objeto de headers: es lo que la pieza llama, y el
// case-insensitive del nombre lo resuelve express y no este archivo.
const reqWith = (key?: string) =>
  ({
    get: (name: string) => (name === INTERNAL_KEY_HEADER ? key : undefined),
  }) as unknown as Request;

const knock = (guard: RequestHandler, key?: string) => {
  const { res, sent } = fakeRes();
  const next = vi.fn();
  guard(reqWith(key), res, next);
  return { sent, next };
};

const guard = requireInternalKey("la-llave");

describe("la puerta de la llave interna", () => {
  it("con la llave correcta deja pasar sin contestar nada", () => {
    const { sent, next } = knock(guard, "la-llave");

    expect(next).toHaveBeenCalledOnce();
    expect(sent.status).toBeUndefined();
  });

  // FALLA CERRADO en las tres formas de no traerla. El 401 es el mismo en las tres: distinguirlas
  // solo le sirve al que está probando llaves.
  it.each([
    ["sin el header", undefined],
    ["con el header vacío", ""],
    ["con otra llave del mismo largo", "la-llavX"],
  ])("%s corta con 401 y no llama al handler", (_name, key) => {
    const { sent, next } = knock(guard, key);

    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({ error: "UNAUTHORIZED" });
    expect(next).not.toHaveBeenCalled();
  });

  // ⚠ LA GUARDA DE LARGO NO ES REDUNDANTE CON LA COMPARACIÓN: `timingSafeEqual` LANZA con buffers
  // de distinto tamaño. Sin ese `a.length === b.length`, una llave de largo equivocado sale 500 en
  // vez de 401 — o sea que el status le dice al que prueba que acertó el largo, que es justo lo
  // que la comparación constante existe para no filtrar.
  it.each([
    ["un prefijo de la llave", "la-lla"],
    ["la llave con algo pegado", "la-llave-de-más"],
  ])("%s corta con 401 y no revienta", (_name, key) => {
    const { sent } = knock(guard, key);

    expect(sent.status).toBe(401);
  });

  // La comparación es de BYTES y no de texto normalizado: una llave es una llave, no un nombre.
  it("distingue mayúsculas de minúsculas", () => {
    const { sent } = knock(guard, "LA-LLAVE");

    expect(sent.status).toBe(401);
  });

  // Y con la llave configurada en blanco no pasa NADIE, ni siquiera el que manda el header vacío:
  // una instalación mal configurada no puede terminar siendo una puerta abierta.
  it("con la llave esperada vacía no deja pasar a nadie", () => {
    const abierta = requireInternalKey("");

    expect(knock(abierta, "").sent.status).toBe(401);
    expect(knock(abierta, undefined).sent.status).toBe(401);
  });
});
