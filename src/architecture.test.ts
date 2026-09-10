import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const VIOLATION_DIR = "src/features/scratch/core";
const VIOLATION_FILE = `${VIOLATION_DIR}/violation.ts`;

function depcruise(): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      "npx",
      ["depcruise", "src", "--config", ".dependency-cruiser.cjs"],
      { encoding: "utf8", shell: true },
    );
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeViolation(source: string): void {
  mkdirSync(VIOLATION_DIR, { recursive: true });
  writeFileSync(VIOLATION_FILE, source, "utf8");
}

afterEach(() => {
  rmSync("src/features/scratch", { recursive: true, force: true });
});

describe("reglas de arquitectura", () => {
  it("el codebase las cumple", () => {
    const { ok, output } = depcruise();
    expect(output).not.toMatch(/error/i);
    expect(ok).toBe(true);
  });

  it("Regla 2: core no puede importar el runtime de Colyseus", () => {
    writeViolation(`import { Room } from "colyseus";\nexport type X = Room;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("core-no-runtime");
  });

  it("Regla 2: core SÍ puede importar @colyseus/schema", () => {
    writeViolation(
      `import { schema, t } from "@colyseus/schema";\nexport const X = schema({ a: t.number() }, "X");\n`,
    );
    const { ok } = depcruise();
    expect(ok).toBe(true);
  });

  it("Regla 3: tsyringe solo en los composition roots", () => {
    writeViolation(`import { container } from "tsyringe";\nexport const c = container;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("tsyringe-only-in-roots");
  });
});
