import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// Dos features desechables usadas solo para violar reglas a propósito. Nunca se commitean:
// afterEach las borra por completo después de cada test.
const FEATURE_A = "scratch";
const FEATURE_B = "scratch-peer";

const FEATURE_A_DIR = `src/features/${FEATURE_A}`;
const FEATURE_B_DIR = `src/features/${FEATURE_B}`;

const CORE_DIR = `${FEATURE_A_DIR}/core`;
const OUTSIDE_DIR = `${FEATURE_A_DIR}/outside`;
const PEER_CORE_DIR = `${FEATURE_B_DIR}/core`;

const VIOLATION_FILE = `${CORE_DIR}/violation.ts`;

function depcruise(): { ok: boolean; output: string } {
  // Se reusa el script de package.json (en vez de invocar `depcruise` directo) para que la
  // regla y el test no puedan divergir en la invocación. Verificado antes de este cambio:
  // `npm run` propaga el exit code del hijo (0 en éxito, 1 en violación) y el stdout que
  // captura sigue conteniendo el nombre de la regla violada.
  try {
    const output = execFileSync("npm", ["run", "depcruise"], { encoding: "utf8", shell: true });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeFile(path: string, source: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, source, "utf8");
}

function writeViolation(source: string): void {
  writeFile(VIOLATION_FILE, source);
}

afterEach(() => {
  // `maxRetries`/`retryDelay` NO son adorno: en Windows, depcruise corrió como subproceso
  // y acaba de leer estos archivos, así que el handle puede seguir abierto unos ms cuando
  // llega el borrado. Sin reintentos eso es un EBUSY intermitente — y un guardarraíl que
  // falla al azar es un guardarraíl que alguien termina desactivando por ruidoso.
  rmSync(FEATURE_A_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(FEATURE_B_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("reglas de arquitectura", () => {
  it("el codebase las cumple", () => {
    const { ok } = depcruise();
    expect(ok).toBe(true);
  });

  it("Regla 1: core-allowlist — core no puede importar fuera de core dentro de su propia feature", () => {
    writeFile(`${OUTSIDE_DIR}/thing.ts`, "export const thing = 1;\n");
    writeViolation(`import { thing } from "../outside/thing";\nexport const x = thing;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("core-allowlist");
  });

  it("Regla 2: core no puede importar el runtime de Colyseus", () => {
    writeViolation(`import { Room } from "colyseus";\nexport type X = Room;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("core-no-runtime");
  });

  it("Regla 2: core-no-runtime también cubre devDependencies (@colyseus/testing)", () => {
    // El hueco: dependencyTypes solo con "npm" no matchea devDependencies, que resuelven como
    // "npm-dev". @colyseus/testing es una devDependency real del proyecto (package.json).
    writeViolation(`import { boot } from "@colyseus/testing";\nexport const bootFn = boot;\n`);
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

  it("Regla 4: feature-boundary — una feature no puede importar de otra salvo por su index.ts", () => {
    writeFile(`${PEER_CORE_DIR}/thing.ts`, "export const peerThing = 1;\n");
    writeFile(
      `${OUTSIDE_DIR}/cross-feature.ts`,
      `import { peerThing } from "../../${FEATURE_B}/core/thing";\nexport const x = peerThing;\n`,
    );
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("feature-boundary");
  });

  // El camino del comando es SÍNCRONO POR CONTRATO. Un await acá reabre la ventana
  // de interleaving que el test del semáforo cierra: dos mensajes del mismo cliente
  // pasarían la validación antes de que el primero mute el turno o la mano, y la misma
  // ficha se jugaría dos veces. Es el complemento estructural de
  // features/match/tests/concurrency-e2e.test.ts — ese prueba el comportamiento de hoy,
  // este impide que mañana alguien lo rompa en silencio.
  //
  // Esta regla NO la puede aplicar dependency-cruiser: mira el grafo de imports, y la
  // asincronía es sintaxis del cuerpo del archivo. Por eso es un test de arquitectura sin
  // depcruise detrás, y de paso no le suma un segundo a los ~17 s que ya cuestan los otros.
  it("no hay await ni async en el core del engine ni en los comandos", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
      });

    const scanned = [
      ...walk("src/features/match/core/commands"),
      ...walk("src/features/match/core/engine"),
    ].filter((path) => !path.includes("/tests/"));

    // La red tiene que estar tendida sobre algo: si un refactor mueve estas carpetas, el
    // walk devuelve vacío y `offenders` sale vacío por la razón equivocada.
    expect(scanned.length).toBeGreaterThan(20);

    // Se miden PALABRAS CLAVE, no menciones: los comentarios se borran antes de buscar.
    // No es relajar la regla, es apuntarla — `core/command.ts` ya documenta el contrato con
    // la frase "si no hay await", y el día que ese párrafo se mude a `core/commands/` el
    // grep crudo se pondría rojo sin que exista una sola espera real. Un guardarraíl que
    // falla por prosa es un guardarraíl que alguien termina borrando.
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

    const offenders = scanned.filter((path) => {
      const source = withoutComments(readFileSync(path, "utf8"));
      return /\bawait\b/.test(source) || /\basync\b/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("no-circular: dos módulos que se importan mutuamente forman un ciclo prohibido", () => {
    writeFile(
      `${FEATURE_A_DIR}/circular-a.ts`,
      `import { b } from "./circular-b";\nexport const a = 1;\nexport const useB = () => b;\n`,
    );
    writeFile(
      `${FEATURE_A_DIR}/circular-b.ts`,
      `import { a } from "./circular-a";\nexport const b = 1;\nexport const useA = () => a;\n`,
    );
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("no-circular");
  });
});
