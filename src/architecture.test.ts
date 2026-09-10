import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  rmSync(FEATURE_A_DIR, { recursive: true, force: true });
  rmSync(FEATURE_B_DIR, { recursive: true, force: true });
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

// La variable global de Node que expone la configuración del proceso. Partida en dos piezas
// y unida en runtime para que el patrón de búsqueda de abajo no aparezca, él mismo, como
// substring contigua en el código fuente de este archivo — si apareciera, este archivo se
// marcaría a sí mismo como infractor la primera vez que corriera el escaneo.
const ENV_READ_TOKEN = ["process", "env"].join(".");

// src/env.ts es el único lector permitido (ver el comentario en la cabecera de ese archivo).
// vitest.setup.ts también toca esa variable, pero vive fuera de src/ —fuera del alcance de
// este escaneo— y además solo escribe defaults de test (`??=`), nunca lee configuración de
// producción: no es el caso que esta regla previene.
const ENV_MODULE_PATH = "src/env.ts";

function listTsFilesUnderSrc(dir = "src"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return listTsFilesUnderSrc(fullPath);
    return entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

function filesReadingEnvOutsideEnvModule(): string[] {
  return listTsFilesUnderSrc()
    .filter((file) => file !== ENV_MODULE_PATH)
    .filter((file) => readFileSync(file, "utf8").includes(ENV_READ_TOKEN));
}

describe("invariante: env.ts es el único lector de la configuración del proceso", () => {
  it("ningún otro archivo bajo src/ la lee directamente", () => {
    expect(filesReadingEnvOutsideEnvModule()).toEqual([]);
  });

  it("detecta una lectura fuera de env.ts si alguien la agrega", () => {
    // Construido en dos piezas por la misma razón que ENV_READ_TOKEN arriba: así el fixture
    // que sí debe ser detectado no contamina, con su propio texto, el archivo que lo genera.
    const globalName = "process";
    const propertyName = "env";
    writeViolation(`export const port = ${globalName}.${propertyName}.PORT;\n`);
    expect(filesReadingEnvOutsideEnvModule()).toContain(VIOLATION_FILE);
  });
});
