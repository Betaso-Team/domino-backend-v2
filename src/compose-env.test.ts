import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

// EL ENTORNO DEL SMOKE DEL DEPLOY, VALIDADO CON EL VALIDADOR DE VERDAD.
//
// `src/env.ts` exige en producción un conjunto de variables que crece —hoy son tres— y el
// servicio del compose corre con `NODE_ENV=production`. Las dos listas viven en archivos que no se
// leen entre sí, y la desincronización NO ROMPE NINGÚN GATE: `tsc` no lee YAML, la suite no levanta
// contenedores, y `npm run test:deploy` necesita un Docker andando que el gate no tiene.
//
// Ya cobró una vez: una variable pasó a ser obligatoria y el servicio del smoke no la tenía. El síntoma era el peor posible para diagnosticar —el servidor
// muere ANTES de escuchar, así que nginx contesta 502 y el cliente del smoke falla midiendo un
// `/ready` que nunca existió— y el rojo apunta a la fase, no a una variable que falta.
//
// SE LLAMA A `parseEnv` Y NO SE COMPARA CONTRA UNA LISTA ESCRITA ACÁ. Una lista sería una tercera
// copia del mismo conjunto y tendría que mantenerse igual que las otras dos; pasarle el entorno al
// validador mide la propiedad que importa —«este contenedor arranca»— y sigue midiéndola sola el
// día que la quinta variable aparezca.

const COMPOSE = "compose.smoke.yaml";

// El bloque `environment:` de un servicio, leído como TEXTO. Parsear YAML pediría una dependencia
// nueva para leer veinte líneas de `CLAVE: valor`, y el archivo es nuestro: no hay anclas, ni
// listas, ni valores multilínea.
//
// SE RECORREN LÍNEAS EN VEZ DE MATCHEAR EL BLOQUE CON UN REGEX MULTILÍNEA, y la primera versión de
// este archivo lo hacía al revés y estaba MAL: el patrón dependía del salto de línea del archivo
// —pasaba con CRLF y fallaba con LF—, y `.gitattributes` normaliza a LF al commitear. O sea que
// habría dado verde acá y rojo en el CI, que es el peor reparto posible. Lo destapó el test
// negativo de este mismo guard, no la corrida normal.
function environmentOf(service: string): Record<string, string> {
  const lines = readFileSync(COMPOSE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""));

  const start = lines.indexOf(`  ${service}:`);
  if (start === -1) throw new Error(`no existe el servicio ${service} en ${COMPOSE}`);

  const env: Record<string, string> = {};
  let inside = false;
  for (const line of lines.slice(start + 1)) {
    // Otro servicio: se terminó el bloque de éste. Es la única condición de corte que hace falta,
    // porque los servicios son las únicas claves con dos espacios de sangría.
    if (/^ {2}\S/.test(line)) break;
    if (line === "    environment:") {
      inside = true;
      continue;
    }
    // Otra clave del servicio (`build:`, `depends_on:`) cierra el `environment:`.
    if (/^ {4}\S/.test(line)) inside = false;
    if (!inside) continue;
    const pair = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (pair?.[1]) env[pair[1]] = (pair[2] ?? "").trim();
  }
  if (Object.keys(env).length === 0) {
    throw new Error(`el servicio ${service} no declara environment en ${COMPOSE}`);
  }
  return env;
}

describe("el entorno del smoke del deploy arranca de verdad", () => {
  it("el servicio del servidor pasa el validador de producción", () => {
    const environment = environmentOf("domino");

    // La red tiene que estar tendida sobre algo: sin esta línea, un regex que dejara de matchear
    // devolvería `{}` y el `expect` de abajo fallaría por la razón equivocada —o peor, pasaría si
    // algún día las obligatorias tuvieran default.
    expect(environment.NODE_ENV).toBe("production");
    expect(Object.keys(environment).length).toBeGreaterThan(10);

    expect(() => parseEnv(environment)).not.toThrow();
  });

  // EL CLIENTE NO CORRE EN PRODUCCIÓN y por eso no necesita las tres, pero sí tiene que parsear:
  // `src/env.ts` se ejecuta al IMPORTARSE, así que un valor mal escrito acá mata el smoke en su
  // primera línea y no en la aserción que iba a medir algo.
  it("el servicio del cliente también parsea", () => {
    const environment = environmentOf("smoke-client");
    expect(environment.RUN_ENGINE_SMOKE).toBe("1");
    expect(() => parseEnv(environment)).not.toThrow();
  });
});
