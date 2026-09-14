// EL IMPORT DE ARRIBA ES PARTE DEL TEST y por eso va primero: `@colyseus/tools` carga un
// `.env` con dotenv en la primera línea de su bundle, así que importarlo acá reproduce
// exactamente el orden que rompía el guardarraíl (setup → dotenv → `src/env.ts`).
import "@colyseus/tools";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, loadEnvFileUnlessTest } from "./env.js";

// LA PROPIEDAD QUE SE DEFIENDE: `npm test` no depende de NINGÚN servicio externo, y eso tiene
// que ser del repo y no del shell —ni del `.env`— de quien lo corre. `vitest.setup.ts` borra
// `MONGO_URI` y `REDIS_URL`; lo que este archivo cubre es que nadie las reponga después.

const FIXTURES: string[] = [];

function fixtureConUnEnv(contenido: string): string {
  const dir = mkdtempSync(join(tmpdir(), "domino-env-"));
  FIXTURES.push(dir);
  const archivo = join(dir, ".env");
  writeFileSync(archivo, contenido, "utf8");
  return archivo;
}

afterEach(() => {
  // Reintentos por lo mismo que en architecture.test.ts: en Windows un handle recién cerrado
  // puede dar EBUSY, y el modo de falla sería igual de confuso por cero beneficio.
  for (const dir of FIXTURES.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("el `.env` no entra a la suite", () => {
  // EL CARGADOR NUESTRO (`src/env.ts`). Se le pasa un entorno de mentira y un doble de la
  // carga, así que mide la decisión sin tocar el entorno real del worker.
  it("no lo carga cuando corre bajo vitest", () => {
    const cargar = vi.fn();
    loadEnvFileUnlessTest({ VITEST: "true" }, cargar);
    expect(cargar).not.toHaveBeenCalled();
  });

  it("sí lo carga cuando no corre bajo vitest", () => {
    const cargar = vi.fn();
    loadEnvFileUnlessTest({}, cargar);
    expect(cargar).toHaveBeenCalledOnce();
  });

  it("un `.env` ausente no es un error: el archivo es opcional a propósito", () => {
    // En producción puede venir todo del entorno del proceso, así que el ENOENT se traga y lo
    // que falte lo dice el parseo del esquema, que sabe listarlo todo junto.
    expect(() =>
      loadEnvFileUnlessTest({}, () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    ).not.toThrow();
  });

  // EL OTRO CARGADOR, el de `@colyseus/tools`. Contra ése no hay orden que sirva —corre al
  // importarse el paquete, o sea después de `vitest.setup.ts`—, así que lo que se comprueba es
  // que la función que usa quedó desactivada. Se le da un destino propio (`processEnv`, que
  // dotenv soporta desde la 16) para medir la inyección sin ensuciar el entorno del worker.
  it("dotenv está desactivado: no inyecta nada de ningún archivo", () => {
    const destino: Record<string, string | undefined> = {};

    dotenv.config({
      path: fixtureConUnEnv("MONGO_URI=mongodb://no-existe:27017/domino\n"),
      processEnv: destino,
      quiet: true,
    });

    expect(destino).toEqual({});
  });

  // EL EXTREMO A EXTREMO, y es el que se vio rojo: con un `.env` local que tenía `MONGO_URI` y
  // `REDIS_URL`, esto devolvía la URI de mentira y la suite entera se iba contra bases de
  // verdad (18 tests rojos en 6 archivos). En un checkout SIN `.env` pasa por vacío, y está
  // bien que así sea: lo que mide es que el archivo del desarrollador no se cuele.
  it("`src/env.ts` no ve ni la URI de Mongo ni la URL de Redis", () => {
    expect(env.mongoUri).toBeUndefined();
    expect(env.redisUrl).toBeUndefined();
  });
});
