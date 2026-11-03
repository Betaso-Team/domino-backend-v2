import type { Response } from "express";
import { describe, expect, it } from "vitest";
import {
  DuplicateGameModeError,
  FreeRoomWithEntryError,
  GameModeForbiddenError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
  UnknownProviderError,
} from "../../core/catalog";
import { sendCatalogError } from "./responses";

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

// CADA ERROR DEL CATÁLOGO, CON SU STATUS Y SU CÓDIGO. El código lo trae el error y la frontera sólo
// elige el status: si alguien cambia uno de los dos, el panel deja de reconocer el error.
describe("sendCatalogError", () => {
  it.each([
    [new DuplicateGameModeError("ya existe"), 409, "MODE_DUPLICATE"],
    [
      new GameModeStateConflictError("MODE_ALREADY_INACTIVE", "ya inactivo"),
      409,
      "MODE_ALREADY_INACTIVE",
    ],
    [
      new GameModeStateConflictError("MODE_ALREADY_ACTIVE", "ya activo"),
      409,
      "MODE_ALREADY_ACTIVE",
    ],
    [new GameModeStateConflictError("MODE_NOT_SHARED", "propio"), 409, "MODE_NOT_SHARED"],
    [new GameModeStateConflictError("MODE_INACTIVE", "inactivo"), 409, "MODE_INACTIVE"],
    [new GameModeStateConflictError("OWN_CATALOG_EMPTY", "vacío"), 409, "OWN_CATALOG_EMPTY"],
    [new GameModeForbiddenError("no es tuyo"), 403, "FORBIDDEN"],
    [new FreeRoomWithEntryError("gratis con entrada"), 400, "FREE_ROOM_WITH_ENTRY"],
    [new GameModeWriteBusyError("ocupado"), 503, "CATALOG_BUSY"],
  ] as const)("%s → %i %s, con el mensaje como detalle", (error, status, code) => {
    const { response, sent } = fakeResponse();
    sendCatalogError(response, error);
    expect(sent).toEqual({ status, body: { code, detail: error.message } });
  });

  // El 404 no lleva detalle: el mensaje del servicio nombra el uuid y es para el log.
  it("un modo que no existe es 404 MODE_NOT_FOUND, sin detalle", () => {
    const { response, sent } = fakeResponse();
    sendCatalogError(response, new GameModeNotFoundError("no existe el modo m-1"));
    expect(sent).toEqual({ status: 404, body: { code: "MODE_NOT_FOUND" } });
  });

  it("otro proveedor es 404 UNKNOWN_PROVIDER, sin detalle", () => {
    const { response, sent } = fakeResponse();
    sendCatalogError(
      response,
      new UnknownProviderError("un proveedor sólo crea modos propios suyos"),
    );
    expect(sent).toEqual({ status: 404, body: { code: "UNKNOWN_PROVIDER" } });
  });

  it("lo que no reconoce lo relanza, para que sea un 500", () => {
    const { response } = fakeResponse();
    const boom = new Error("la base no contesta");
    expect(() => sendCatalogError(response, boom)).toThrow(boom);
  });
});
