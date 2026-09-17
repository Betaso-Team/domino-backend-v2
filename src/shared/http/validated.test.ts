import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validated } from "./validated";

// Un `res` mínimo que recuerda con qué lo llamaron. No hace falta más: la pieza solo puede
// hacer dos cosas con la respuesta —dejar pasar al handler, o cortar con un 400—.
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

const reqWith = (parts: Partial<Record<"params" | "query" | "body", unknown>>) =>
  parts as unknown as Request;

describe("validated (la costura de entrada del HTTP)", () => {
  it("parsea cada fuente declarada y se la pasa al handler ya válida", () => {
    const handle = vi.fn();
    const { res } = fakeRes();

    validated(
      { params: z.object({ roomId: z.string() }), query: z.object({ n: z.coerce.number() }) },
      handle,
    )(reqWith({ params: { roomId: "abc" }, query: { n: "7" } }), res, vi.fn());

    // El `coerce` prueba que lo que llega al handler es lo PARSEADO y no lo crudo: `"7"`
    // entró como string del query y sale como número.
    expect(handle).toHaveBeenCalledWith(
      { params: { roomId: "abc" }, query: { n: 7 }, body: undefined },
      res,
    );
  });

  it("corta con 400 y el MISMO código que el socket, sin llamar al handler", () => {
    const handle = vi.fn();
    const { res, sent } = fakeRes();

    validated({ params: z.object({ roomId: z.string() }) }, handle)(
      reqWith({ params: { roomId: 42 } }),
      res,
      vi.fn(),
    );

    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "MALFORMED" });
    expect((sent.body as { detail: string }).detail).toBeTruthy();
    expect(handle).not.toHaveBeenCalled();
  });

  // Lo que el endpoint no declara NO viaja, aunque venga en el request. Es la misma
  // frontera del wire de Colyseus: el handler ve lo que el schema dejó pasar y nada más.
  it("descarta las fuentes que el endpoint no declaró", () => {
    const handle = vi.fn();
    const { res } = fakeRes();

    validated({ params: z.object({ roomId: z.string() }) }, handle)(
      reqWith({ params: { roomId: "abc" }, query: { admin: "true" }, body: { rol: "ADMIN" } }),
      res,
      vi.fn(),
    );

    expect(handle).toHaveBeenCalledWith(
      { params: { roomId: "abc" }, query: undefined, body: undefined },
      res,
    );
  });

  it("un rechazo del handler async sale por next(), no como promesa suelta", async () => {
    const boom = new Error("explotó");
    const next = vi.fn();
    const { res } = fakeRes();

    validated({}, async () => {
      throw boom;
    })(reqWith({}), res, next);

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(boom));
  });

  // PRUEBA DE COMPILACIÓN: si el tipo derivado se rompiera, esto no compila y
  // `npm run typecheck` falla. Es la garantía de que el schema y el handler no pueden
  // divergir. Vitest NO la ve —esbuild borra los tipos sin chequearlos—, así que el rojo
  // de esta aserción vive en `tsc --noEmit` y no en la suite.
  it("deriva el tipo de la entrada desde los schemas", () => {
    validated({ params: z.object({ id: z.string() }) }, ({ params, query, body }) => {
      const id: string = params.id; // la declarada llega TIPADA
      const sinQuery: undefined = query; // la no declarada llega `undefined`, no `any`
      const sinBody: undefined = body;
      expect([id, sinQuery, sinBody]).toEqual(["x", undefined, undefined]);
    })(reqWith({ params: { id: "x" } }), fakeRes().res, vi.fn());
  });
});
