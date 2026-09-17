import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// Devuelve TODOS los `.ts` de un árbol, tests incluidos. La usan los dos tests de acá que no
// pasan por depcruise: el de la asincronía del core —que filtra los `.test.ts` porque la
// regla es sobre el código que se despliega— y el de la ubicación única del validador HTTP,
// que justamente necesita verlos para atrapar una copia del test.
function walkTs(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) return walkTs(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

// Se miden PALABRAS CLAVE, no menciones: los comentarios se borran antes de buscar.
// Se recorre el archivo para no confundir el `//` de una URL dentro de un string con un
// comentario. Los strings se conservan para errar hacia un rojo visible, nunca hacia un
// verde silencioso, si contienen `async`/`await` o si aparece una sintaxis no contemplada.
function withoutComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      // Load-bearing: sin el espacio, `x/*c*/async` se fusiona en `xasync` y escapa de
      // `\basync\b`. Ambos tipos de comentario deben conservar la frontera léxica.
      out += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        out += inner;
        index += 1;
        // La barra invertida se lleva puesto al siguiente sea cual sea: así una comilla
        // escapada no cierra el string y el escáner no se desincroniza.
        if (inner === "\\") {
          if (index < source.length) {
            out += source[index];
            index += 1;
          }
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
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

  // El hueco que tapa esta regla: a tsyringe NADIE llega por el paquete, se llega
  // importando `rootContainer` de src/di-container.ts — un import LOCAL, que la condición
  // sobre `^node_modules/tsyringe/` no mira. Sin este caso la Regla 3 vuelve a quedar verde
  // sobre cualquier archivo que resuelva del root, que es como llegó acá.
  it("Regla 3: nadie fuera de un composition root importa el container", () => {
    writeFile(
      `${OUTSIDE_DIR}/container-user.ts`,
      `import { rootContainer } from "../../../di-container";\nexport const c = rootContainer;\n`,
    );
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("di-container-only-in-roots");
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
  it("no hay await ni async en el core del engine ni en los comandos", () => {
    const scanned = [
      ...walkTs("src/features/match/core/commands"),
      ...walkTs("src/features/match/core/engine"),
    ].filter((path) => !path.endsWith(".test.ts") && !path.includes("/tests/"));

    // La red tiene que estar tendida sobre algo: si un refactor mueve estas carpetas, el
    // walk devuelve vacío y `offenders` sale vacío por la razón equivocada.
    expect(scanned.length).toBeGreaterThan(20);

    const offenders = scanned.filter((path) => {
      const source = withoutComments(readFileSync(path, "utf8"));
      return /\bawait\b/.test(source) || /\basync\b/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  // El validador de la frontera HTTP tiene UNA ubicación, `shared/http/`, y la Regla 4 es lo
  // que la vuelve obligatoria: en cuanto una segunda feature necesita `validated`, importarlo
  // de `features/match/transports/http/` es una violación de `feature-boundary`, y la salida
  // barata frente a ese error es copiar el archivo. Dos copias de la costura que decide qué
  // entra al sistema divergen en silencio: la que arreglás no es la que corre.
  //
  // DEPCRUISE NO PUEDE APLICARLO. Mira ARISTAS del grafo, y "este archivo no existe en esta
  // carpeta" no es una arista: una copia sin importadores no produce ninguna. Por eso es un
  // test de arquitectura sin depcruise detrás, igual que el de la asincronía del core.
  it("el validador HTTP vive solo en shared/http, y de ahí lo importa todo el mundo", () => {
    const files = walkTs("src");
    // La red tiene que estar tendida sobre algo: si el walk devolviera vacío, las tres
    // aserciones de abajo pasarían por la razón equivocada.
    expect(files.length).toBeGreaterThan(100);

    // La ubicación única existe...
    expect(files).toContain("src/shared/http/validated.ts");
    // ...y no hay ninguna copia bajo `features/`, ni de la pieza ni de su test.
    expect(
      files.filter((file) => /^src\/features\/.*\/validated(\.test)?\.ts$/.test(file)),
    ).toEqual([]);

    // Y el que lo usa lo importa de ahí. Sin esta parte, un `validated.ts` renombrado dentro
    // de una feature dejaría el guard verde sobre la misma duplicación. Los archivos de
    // `shared/http/` quedan afuera porque el import correcto desde ahí es `./validated.js`.
    const offenders = files
      .filter((file) => !file.startsWith("src/shared/http/"))
      .filter((file) => {
        const specifiers = readFileSync(file, "utf8").match(/from "[^"]*validated\.js"/g) ?? [];
        return specifiers.some((specifier) => !specifier.endsWith('shared/http/validated.js"'));
      });
    expect(offenders).toEqual([]);
  });

  // LA QUINTA REGLA: un import que SALE del módulo se escribe con `@/`, nunca trepando con `../`.
  //
  // No es cosmética, y la razón es la misma por la que existen las otras cuatro: `../../../../` no
  // dice de dónde a dónde va la arista. `@/logger.js` sí, y con eso "este archivo cruza una
  // frontera" se lee de un vistazo en vez de contando puntos — que es exactamente lo que las cuatro
  // reglas de arriba gobiernan. De paso, mover un archivo deja de reescribir los imports de sus
  // vecinos.
  //
  // EL MÓDULO ES LA FEATURE, no el directorio: adentro de `features/match/` los imports son
  // relativos y eso es lo correcto —son cortos, y sobreviven a que la feature entera se mueva—. El
  // alias marca la SALIDA.
  //
  // DEPCRUISE NO PUEDE APLICARLO, por lo mismo que el guard del validador: resuelve los alias antes
  // de mirar el grafo, así que para él las dos formas del mismo import son la MISMA arista. La
  // forma del especificador solo se ve leyendo el archivo.
  it("Regla 5: lo que sale del módulo se importa con `@/`, no trepando con `../`", () => {
    // El módulo de un archivo: su feature si vive en una, su directorio de primer nivel si no, y
    // `src` a secas para los archivos de la raíz —donde `./vecino.js` sí es lo correcto—.
    const moduleRootOf = (file: string): string => {
      const parts = file.split("/");
      if (parts.length > 3 && parts[1] === "features") return parts.slice(0, 3).join("/");
      if (parts.length > 2) return parts.slice(0, 2).join("/");
      return "src";
    };

    const files = walkTs("src").filter((file) => file !== "src/architecture.test.ts");
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.flatMap((file) => {
      const root = moduleRootOf(file);
      const dir = file.slice(0, file.lastIndexOf("/"));
      const specifiers = [...readFileSync(file, "utf8").matchAll(/from "(\.\.?\/[^"]*)"/g)].map(
        (match) => match[1] ?? "",
      );
      return specifiers
        .filter((specifier) => {
          // Se normaliza a mano y no con `node:path`: `posix.normalize` en Windows deja
          // separadores mezclados, y este test compara CADENAS.
          const segments = `${dir}/${specifier}`.split("/");
          const resolved: string[] = [];
          for (const segment of segments) {
            if (segment === "..") resolved.pop();
            else if (segment !== ".") resolved.push(segment);
          }
          const target = resolved.join("/");
          const inside =
            root === "src"
              ? target.slice(0, target.lastIndexOf("/")) === "src"
              : target.startsWith(`${root}/`);
          return !inside;
        })
        .map((specifier) => `${file} → ${specifier}`);
    });

    // Se nombran los infractores en vez de contarlos: un `toHaveLength(0)` deja al que lo rompe
    // buscando cuál de doscientos archivos fue.
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
