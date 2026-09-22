import type { Request, RequestHandler, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Identity, InvalidTokenError, type TokenVerifier } from "../identity";
import { authenticated, requireBearer } from "./bearer";

// LA MISMA PUERTA DEL `onAuth` DE LAS SALAS, sobre HTTP. Lo que se mide es la lectura de la
// credencial y, sobre todo, las dos formas de CORTAR, porque cada una miente de un modo distinto:
// un 401 sobre una falla nuestra hace que el cliente borre una sesión que está bien, y un 400 antes
// del 401 le cuenta a un anónimo qué entradas aceptamos.

const ADA: Identity = { userId: "ada" };

const verifier = (result: (token: string | undefined) => Promise<Identity>): TokenVerifier => ({
  verify: vi.fn(result),
});

const ok = () =>
  verifier(async (token) =>
    token === "bueno" ? ADA : Promise.reject(new InvalidTokenError("no es")),
  );

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

const reqWith = (authorization?: string, body?: unknown) =>
  ({ headers: { authorization }, body, params: {}, query: {} }) as unknown as Request;

// La pieza encadena promesas sin devolverlas —es una middleware de express, no puede—, así que el
// test tiene que dejar drenar la cola de microtareas antes de mirar. `setImmediate` corre DESPUÉS
// de todas ellas; esperar un desenlace concreto no serviría, porque el camino feliz de
// `authenticated` no llama a `next` ni contesta: le pasa el control al handler y ahí se termina.
const knock = async (door: RequestHandler, authorization?: string, body?: unknown) => {
  const { res, sent } = fakeRes();
  const next = vi.fn();
  door(reqWith(authorization, body), res, next);
  await new Promise((resume) => setImmediate(resume));
  return { sent, next };
};

describe("requireBearer", () => {
  it("con el token bueno deja pasar sin contestar nada", async () => {
    const { sent, next } = await knock(requireBearer(ok()), "Bearer bueno");

    expect(next).toHaveBeenCalledWith();
    expect(sent.status).toBeUndefined();
  });

  // EL PREFIJO SE COMPARA SIN MAYÚSCULAS: es lo que hace el resto del mundo con este header, y un
  // `bearer` en minúscula es un cliente correcto y no uno sin credencial.
  it.each(["Bearer bueno", "bearer bueno", "BEARER bueno", "Bearer   bueno  "])(
    "lee el token de %o",
    async (header) => {
      const door = ok();

      await knock(requireBearer(door), header);

      expect(door.verify).toHaveBeenCalledWith("bueno");
    },
  );

  // LO QUE NO ES UN BEARER LLEGA COMO `undefined` AL VERIFICADOR, y es el verificador —y no esta
  // pieza— el que decide que eso es un token inválido. Partir la decisión en dos deja dos lugares
  // donde se puede aflojar.
  it.each([
    ["sin el header", undefined],
    ["sin el prefijo", "bueno"],
    ["con otro esquema", "Basic bueno"],
  ])("%s le pasa undefined al verificador y contesta 401", async (_name, header) => {
    const door = ok();

    const { sent, next } = await knock(requireBearer(door), header);

    expect(door.verify).toHaveBeenCalledWith(undefined);
    expect(sent.status).toBe(401);
    // El 401 NO dice cuál de los tres motivos fue. Distinguir «no llegó» de «venció» ayuda en el
    // socket, donde la sesión se sostiene; en una consulta suelta solo ayuda al que prueba tokens.
    expect(sent.body).toEqual({ code: "UNAUTHORIZED" });
    expect(next).not.toHaveBeenCalled();
  });

  // ⚠ EL PREFIJO PELADO NO LLEGA COMO `undefined` SINO COMO `""`: el esquema está, así que la
  // credencial se extrae y sale vacía. Sale 401 igual —es el verificador el que lo rechaza— y por
  // eso la asimetría no es un defecto; queda fijada acá para que nadie la "arregle" moviendo la
  // decisión de qué es un token vacío a esta pieza, donde después habría que mantenerla dos veces.
  it("el prefijo pelado llega vacío al verificador, y también es 401", async () => {
    const door = ok();

    const { sent } = await knock(requireBearer(door), "Bearer ");

    expect(door.verify).toHaveBeenCalledWith("");
    expect(sent.status).toBe(401);
  });

  // ⚠ UNA FALLA NUESTRA NO ES UN 401, y es la guarda menos obvia del archivo. Si el verificador
  // revienta porque le falta el secreto o porque el emisor no contesta, contestar «no autorizado»
  // le dice al cliente que su sesión está mal y lo manda a borrarla: un incidente de configuración
  // se convierte en todos los jugadores deslogueados. Va al manejador de errores, que lo hace 500.
  it("una falla que no es de credencial va al manejador de errores, no a un 401", async () => {
    const roto = new Error("falta el secreto");

    const { sent, next } = await knock(
      requireBearer(verifier(async () => Promise.reject(roto))),
      "Bearer bueno",
    );

    expect(next).toHaveBeenCalledWith(roto);
    expect(sent.status).toBeUndefined();
  });
});

describe("authenticated", () => {
  const schemas = { body: z.object({ monto: z.number() }) };
  const doorWith = (handle: Parameters<typeof authenticated>[2], v: TokenVerifier = ok()) =>
    authenticated(v, schemas, handle);

  // TODA SU DIFERENCIA CON `requireBearer` es que la identidad SOBREVIVE al chequeo en vez de
  // tirarse. Es una pieza y no una middleware más un lector porque no hay dónde dejarla en el
  // medio: el validador le entrega al handler la entrada ya tipada y a propósito nunca le entrega
  // el request.
  it("le entrega al handler la identidad y la entrada ya parseada", async () => {
    const handle = vi.fn();

    await knock(doorWith(handle), "Bearer bueno", { monto: 7 });

    expect(handle).toHaveBeenCalledWith(
      ADA,
      { params: undefined, query: undefined, body: { monto: 7 } },
      expect.anything(),
    );
  });

  // ⚠ EL CHEQUEO CORRE ANTES QUE LA FORMA, y el orden es la aserción: con el cuerpo inválido Y sin
  // credencial la respuesta es 401 y no 400. No hay motivo para contarle a un anónimo qué entradas
  // aceptamos — un 400 es un mapa de la API para el que todavía no probó una sola llave.
  it("con el cuerpo inválido y sin credencial contesta 401, no 400", async () => {
    const handle = vi.fn();

    const { sent } = await knock(doorWith(handle), undefined, { monto: "no es un número" });

    expect(sent.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it("autenticado pero con el cuerpo inválido sí contesta 400", async () => {
    const handle = vi.fn();

    const { sent } = await knock(doorWith(handle), "Bearer bueno", { monto: "no es un número" });

    expect(sent.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  // La misma política de arriba: una falla nuestra no se disfraza de credencial mala.
  it("una falla que no es de credencial va al manejador de errores", async () => {
    const roto = new Error("falta el secreto");
    const handle = vi.fn();

    const { sent, next } = await knock(
      doorWith(
        handle,
        verifier(async () => Promise.reject(roto)),
      ),
      "Bearer bueno",
      { monto: 7 },
    );

    expect(next).toHaveBeenCalledWith(roto);
    expect(sent.status).toBeUndefined();
    expect(handle).not.toHaveBeenCalled();
  });
});
