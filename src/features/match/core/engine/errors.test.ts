import { describe, expect, it } from "vitest";
import { DominoError, InvariantViolationError, RuleViolationError } from "./errors";

describe("jerarquía de errores", () => {
  it("una violación de regla lleva un código para la UI y los logs", () => {
    const error = new RuleViolationError("NOT_YOUR_TURN");
    expect(error.code).toBe("NOT_YOUR_TURN");
    expect(error).toBeInstanceOf(DominoError);
    expect(error).toBeInstanceOf(Error);
  });

  it("una invariante rota es un bug, y se distingue por su clase", () => {
    const error = new InvariantViolationError("no hay ronda en curso");
    expect(error).toBeInstanceOf(DominoError);
    expect(error).not.toBeInstanceOf(RuleViolationError);
  });

  it("el nombre de la clase sobrevive, para que el log sea legible", () => {
    expect(new RuleViolationError("NOT_YOUR_TURN").name).toBe("RuleViolationError");
    expect(new InvariantViolationError("x").name).toBe("InvariantViolationError");
  });
});
