import type { Response } from "express";
import { describe, expect, it } from "vitest";
import { sendError } from "./errors";

function fakeResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, sent };
}

describe("sendError", () => {
  it("contesta { code } cuando no hay detalle, sin una clave detail vacía", () => {
    const { response, sent } = fakeResponse();
    sendError(response, 404, "MATCH_NOT_FOUND");
    expect(sent).toEqual({ status: 404, body: { code: "MATCH_NOT_FOUND" } });
    expect(Object.keys(sent.body as object)).toEqual(["code"]);
  });

  it("contesta { code, detail } cuando hay detalle", () => {
    const { response, sent } = fakeResponse();
    sendError(response, 503, "MATCH_LIST_TIMEOUT", "acota el rango");
    expect(sent).toEqual({
      status: 503,
      body: { code: "MATCH_LIST_TIMEOUT", detail: "acota el rango" },
    });
  });
});
