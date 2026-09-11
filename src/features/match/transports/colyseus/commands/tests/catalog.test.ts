import { describe, expect, it, vi } from "vitest";
import { UnknownCommandError } from "../../errors.js";
import { CommandCatalog } from "../catalog.js";

const build = () =>
  new CommandCatalog(
    { ABANDON: { decode: vi.fn(() => ({ playerId: "u1" })) } },
    { ABANDON: { execute: vi.fn(() => []) } },
  );

describe("CommandCatalog", () => {
  it("acepta un verbo que existe", () => {
    expect(build().accepts("ABANDON")).toBe(true);
  });

  it("rechaza un verbo que no existe", () => {
    expect(build().accepts("PLAY_TILE")).toBe(false);
  });

  // EL CASO QUE IMPORTA. Con `in` en vez de Object.hasOwn, "toString" pasa la
  // frontera —el prototipo cuenta—, se lleva un command() undefined, su .execute
  // revienta en TypeError y la política de errores traduce eso a CERRAR la partida.
  // Un mensaje de una línea mataba la mesa.
  it("rechaza los nombres heredados de Object.prototype", () => {
    const catalog = build();
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(catalog.accepts(name)).toBe(false);
    }
  });

  it("pedir el decoder de un verbo inexistente lanza UnknownCommandError", () => {
    expect(() => build().decoder("toString")).toThrow(UnknownCommandError);
  });

  it("pedir el comando de un verbo inexistente lanza UnknownCommandError", () => {
    expect(() => build().command("nope")).toThrow(UnknownCommandError);
  });
});
