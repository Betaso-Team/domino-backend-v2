import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// Único lector permitido de la configuración del proceso. Ver la cabecera de src/env.ts.
const ENV_MODULE_PATH = "src/env.ts";

// Este archivo se excluye también: su propio código fuente contiene, literalmente, la
// substring "process.env" (en este comentario, en el patrón de abajo y en los fixtures que
// escribe a propósito para probar que el escaneo dispara). Excluirlo por ruta es más simple y
// legible que ofuscar esas apariciones — y no abre un hueco real, porque este archivo no lee
// configuración de ningún proceso, solo texto sobre cómo detectarla.
const THIS_FILE_PATH = "src/env-single-reader.test.ts";

const EXCLUDED_PATHS = new Set([ENV_MODULE_PATH, THIS_FILE_PATH]);

// Lo que detecta:
//   - `process.env` en cualquier forma (acceso global directo, o vía un import por defecto
//     del módulo `process` al que se le haya dejado ese mismo nombre local).
//   - Cualquier import nombrado o de namespace de los módulos `process` / `node:process`
//     (p.ej. `import { env } from "node:process"`), que es la vía idiomática para leer `env`
//     sin que la substring "process.env" aparezca nunca en el archivo.
//
// Lo que NO detecta (blind spots documentados a propósito, no resueltos — mantenerlo simple):
//   - `process["env"]` o cualquier acceso por índice dinámico/computado.
//   - `globalThis.process.env`.
//   - Reexportar `process.env` desde un módulo propio e importar ESE módulo en vez de `env.ts`.
//   - Desestructurar `process` en un alias y acceder a `alias.env` en otra línea/archivo.
const IMPORTS_PROCESS_MODULE = /from\s+["'](?:node:)?process["']/;

function readsProcessEnv(source: string): boolean {
  return source.includes("process.env") || IMPORTS_PROCESS_MODULE.test(source);
}

function listTsFilesUnderSrc(dir = "src"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return listTsFilesUnderSrc(fullPath);
    return entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

function filesReadingEnvOutsideEnvModule(): string[] {
  return listTsFilesUnderSrc()
    .filter((file) => !EXCLUDED_PATHS.has(file))
    .filter((file) => readsProcessEnv(readFileSync(file, "utf8")));
}

// Fixture desechable usado solo para probar que el escaneo dispara. Nunca se commitea:
// afterEach lo borra por completo después de cada test.
const FIXTURE_DIR = "src/features/scratch-env-guardrail";
const FIXTURE_FILE = `${FIXTURE_DIR}/violation.ts`;

function writeFixture(source: string): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_FILE, source, "utf8");
}

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("invariante: env.ts es el único lector de la configuración del proceso", () => {
  it("ningún otro archivo bajo src/ la lee directamente", () => {
    expect(filesReadingEnvOutsideEnvModule()).toEqual([]);
  });

  it("detecta process.env fuera de env.ts", () => {
    writeFixture("export const port = process.env.PORT;\n");
    expect(filesReadingEnvOutsideEnvModule()).toContain(FIXTURE_FILE);
  });

  it("detecta un import { env } from 'node:process' aunque nunca escriba la substring process.env", () => {
    writeFixture('import { env } from "node:process";\nexport const port = env.PORT;\n');
    expect(filesReadingEnvOutsideEnvModule()).toContain(FIXTURE_FILE);
  });
});
