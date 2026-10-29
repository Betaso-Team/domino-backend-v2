import type { Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  API_KEY_ADMIN,
  API_KEY_HEADER,
  type Admin,
  type AdminAccess,
  adminOf,
  requireAdminKey,
  requireApiKey,
} from "./api-key";

// LA PUERTA DE LAS RUTAS INTERNAS: la que pide la llave que el PANEL DE ADMINISTRACIÓN presenta para
// administrar el catálogo, el mantenimiento, el historial de soporte y la configuración en caliente.
//
// ⚠ ES LA MITAD ENTRANTE. Viaja en el MISMO header que la saliente (`features/auth/api-key.ts`, la
// llave que NOSOTROS presentamos al backend de Betaso), pero es OTRO secreto: el header es un
// contrato de Betaso y el secreto es de cada dirección.
//
// La llave no dice QUIÉN habla, dice que el que habla es un servidor autorizado: vale como un admin de
// Betaso Games (`API_KEY_ADMIN`) y las rutas que protege no pueden auditar a una persona.

function fakeRes() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    locals: {} as Record<string, unknown>,
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

// EL PANEL CON SESIÓN: el admin presenta el token que billing-auth le emitió al iniciar sesión.
// Este archivo no verifica tokens (eso es `features/auth`): recibe quién es, o nadie.
const ANA: Admin = { name: "ana", provider: null, role: "admin" };
const SOPORTE: Admin = { name: "sol", provider: null, role: "support" };
const PARLEY: Admin = { name: "pia", provider: "parley", role: "admin" };
const PARLEY_SOPORTE: Admin = { name: "pedro", provider: "parley", role: "support" };
const BY_TOKEN: Record<string, Admin> = {
  "token-de-ana": ANA,
  "token-de-sol": SOPORTE,
  "token-de-pia": PARLEY,
  "token-de-pedro": PARLEY_SOPORTE,
};
const adminTokens = async (token: string) => BY_TOKEN[token];

const knockWithBearer = async (handler: RequestHandler, token: string) => {
  const { res, sent } = fakeRes();
  const next = vi.fn();
  const req = {
    get: (name: string) => (name === "authorization" ? `Bearer ${token}` : undefined),
  } as unknown as Request;
  handler(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { sent, next, locals: (res as unknown as { locals: Record<string, unknown> }).locals };
};

describe("la puerta con un token de admin", () => {
  it("deja pasar a un admin de Betaso Games, y deja su principal en locals", async () => {
    const { next, locals } = await knockWithBearer(
      requireAdminKey("la-llave", adminTokens),
      "token-de-ana",
    );
    expect(next).toHaveBeenCalledOnce();
    expect(locals.admin).toEqual(ANA);
  });

  it("la llave deja el principal de Betaso Games con rol admin", () => {
    const { res } = fakeRes();
    const next = vi.fn();
    requireAdminKey("la-llave")(reqWith("la-llave"), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(adminOf(res)).toEqual(API_KEY_ADMIN);
    expect(API_KEY_ADMIN).toMatchObject({ provider: null, role: "admin" });
  });

  it("un token que no es de admin es 401, y sin verificador ningún token abre", async () => {
    const bad = await knockWithBearer(requireAdminKey("la-llave", adminTokens), "basura");
    expect(bad.sent).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
    const keyOnly = await knockWithBearer(requireAdminKey("la-llave"), "token-de-ana");
    expect(keyOnly.sent).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
  });
});

// ⚠ EL DEFAULT ES EL CERRADO, y es lo que impide que un admin de PROVEEDOR entre como admin total el
// día que billing-auth empiece a emitir sus tokens: una ruta que no declara nada es de escritura y
// de Betaso Games. La matriz entera, una fila por credencial y una columna por lo que la ruta abre.
describe("lo que abre cada puerta", () => {
  const cases: Array<[string, AdminAccess, string, boolean]> = [
    ["el default", {}, "token-de-ana", true],
    ["el default", {}, "token-de-sol", false],
    ["el default", {}, "token-de-pia", false],
    ["el default", {}, "token-de-pedro", false],
    ["read", { read: true }, "token-de-ana", true],
    ["read", { read: true }, "token-de-sol", true],
    ["read", { read: true }, "token-de-pia", false],
    ["read", { read: true }, "token-de-pedro", false],
    ["providers", { providers: true }, "token-de-ana", true],
    ["providers", { providers: true }, "token-de-sol", false],
    ["providers", { providers: true }, "token-de-pia", true],
    ["providers", { providers: true }, "token-de-pedro", false],
    ["providers + read", { providers: true, read: true }, "token-de-ana", true],
    ["providers + read", { providers: true, read: true }, "token-de-sol", true],
    ["providers + read", { providers: true, read: true }, "token-de-pia", true],
    ["providers + read", { providers: true, read: true }, "token-de-pedro", true],
  ];

  it.each(cases)("%s (%o) con %s abre: %s", async (_label, access, token, opens) => {
    const { sent, next, locals } = await knockWithBearer(
      requireAdminKey("la-llave", adminTokens, access),
      token,
    );
    if (opens) {
      expect(next).toHaveBeenCalledOnce();
      expect(locals.admin).toEqual(BY_TOKEN[token]);
    } else {
      expect(next).not.toHaveBeenCalled();
      expect(sent).toEqual({ status: 403, body: { error: "FORBIDDEN" } });
      expect(locals.admin).toBeUndefined();
    }
  });

  it("adminOf lanza en una ruta sin la puerta adelante", () => {
    const { res } = fakeRes();
    expect(() => adminOf(res)).toThrow("sin requireAdminKey");
  });
});

// LA LLAVE DEL ORQUESTADOR: sólo la llave, ningún token, y sin principal (el orquestador no es un
// admin).
describe("la puerta de una llave de servidor", () => {
  it("abre con la llave, no deja principal y no acepta tokens", async () => {
    const { res } = fakeRes();
    const next = vi.fn();
    requireApiKey("la-llave")(reqWith("la-llave"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((res as unknown as { locals: Record<string, unknown> }).locals.admin).toBeUndefined();

    const token = await knockWithBearer(requireApiKey("la-llave"), "token-de-ana");
    expect(token.sent).toEqual({ status: 401, body: { error: "UNAUTHORIZED" } });
    expect(knock(requireApiKey(""), "").sent.status).toBe(401);
  });
});
