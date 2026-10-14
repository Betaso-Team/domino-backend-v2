import type { Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { API_KEY_HEADER, requireAdminKey } from "./api-key";

// LA PUERTA DE LAS RUTAS INTERNAS: la que pide la llave que el PANEL DE ADMINISTRACIÓN presenta para
// administrar el catálogo, el mantenimiento, el historial de soporte y la configuración en caliente.
//
// ⚠ ES LA MITAD ENTRANTE. Viaja en el MISMO header que la saliente (`features/auth/api-key.ts`, la
// llave que NOSOTROS presentamos al backend de Betaso), pero es OTRO secreto: el header es un
// contrato de Betaso y el secreto es de cada dirección.
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
    get: (name: string) => (name === API_KEY_HEADER ? key : undefined),
  }) as unknown as Request;

const knock = (guard: RequestHandler, key?: string) => {
  const { res, sent } = fakeRes();
  const next = vi.fn();
  guard(reqWith(key), res, next);
  return { sent, next };
};

const guard = requireAdminKey("la-llave");

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
    const abierta = requireAdminKey("");

    expect(knock(abierta, "").sent.status).toBe(401);
    expect(knock(abierta, undefined).sent.status).toBe(401);
  });
});

// EL PANEL CON SESIÓN: el operador presenta el token que billing-auth le emitió al iniciar sesión.
// Este archivo no verifica tokens (eso es `features/auth`): recibe quién es, o nadie.
describe("la puerta con un token de operador", () => {
  const operators = async (token: string) =>
    token === "token-de-ana"
      ? { name: "ana", roles: ["catalog"] }
      : token === "token-de-luis"
        ? { name: "luis", roles: [] }
        : undefined;

  const knockWithBearer = async (handler: RequestHandler, token: string) => {
    const { res, sent } = fakeRes();
    (res as unknown as { locals: Record<string, unknown> }).locals = {};
    const next = vi.fn();
    const req = {
      get: (name: string) => (name === "authorization" ? `Bearer ${token}` : undefined),
    } as unknown as Request;
    handler(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));
    return { sent, next, locals: (res as unknown as { locals: Record<string, unknown> }).locals };
  };

  it("deja pasar a un operador con el rol que pide la ruta, y lo nombra", async () => {
    const { next, locals } = await knockWithBearer(
      requireAdminKey("la-llave", operators, "catalog"),
      "token-de-ana",
    );
    expect(next).toHaveBeenCalledOnce();
    expect(locals.operator).toBe("ana");
  });

  it("a un operador sin ese rol le contesta 403", async () => {
    const { sent, next } = await knockWithBearer(
      requireAdminKey("la-llave", operators, "catalog"),
      "token-de-luis",
    );
    expect(next).not.toHaveBeenCalled();
    expect(sent).toEqual({ status: 403, body: { error: "FORBIDDEN" } });
  });

  it("a una lectura sin rol pedido la abre cualquier operador", async () => {
    const { next } = await knockWithBearer(requireAdminKey("la-llave", operators), "token-de-luis");
    expect(next).toHaveBeenCalledOnce();
  });

  it("un token que no es de operador es 401, y sin verificador ningún token abre", async () => {
    const bad = await knockWithBearer(requireAdminKey("la-llave", operators), "basura");
    expect(bad.sent).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
    const keyOnly = await knockWithBearer(requireAdminKey("la-llave"), "token-de-ana");
    expect(keyOnly.sent).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
  });
});
