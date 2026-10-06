import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const WORKERS = Math.max(4, availableParallelism() - 1);

export default defineConfig({
  // EL ALIAS `@/*` → `src/*`, EN PARALELO AL `paths` DEL TSCONFIG, y hace falta declararlo dos
  // veces porque cada herramienta lo lee de un lado distinto: `tsc` y `tsup` (esbuild) lo sacan del
  // tsconfig, `depcruise` también —por su `options.tsConfig`—, y Vite no lo mira. Sin esta línea el
  // typecheck estaría verde y la suite entera no resolvería un solo import.
  //
  // Las extensiones las resuelve Vite: el alias deja un path que termina en `.js` y del otro lado
  // hay un `.ts`, exactamente como ya pasa con los imports relativos del repo.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // `forks` (el default) rompe: @colyseus/tools usa process.send y choca con su IPC.
    pool: "threads",
    // AL MENOS CUATRO HILOS, tenga los núcleos que tenga (truco `dfc6603`). El runner del CI tiene
    // dos, y el default de vitest es uno menos: un hilo, con los E2E corriendo uno detrás del otro.
    // Ésos esperan sockets y relojes reales, no CPU, así que se solapan bien por encima de la cuenta
    // de núcleos; en dos núcleos, mucho más allá de cuatro empiezan a pelear por la CPU y los plazos
    // reales se vuelven inestables. Una máquina más grande conserva el default.
    //
    // El pool se lee SÓLO de acá: vitest 3 ignora `poolOptions` —y `isolate`— dentro de un
    // proyecto (medido: el `prepare` de `unit` no se movió). Por eso `isolate: false` —lo que
    // abarata `unit` e `int`, cuyo costo era re-importar el grafo de módulos por archivo— es un flag
    // de sus scripts en `package.json` y no una opción: los E2E no pueden compartirlo, cada uno
    // levanta el servidor sobre `rootContainer`, que es estado de módulo. El precio del flag: un
    // archivo unitario que deja estado global atrás (un mock sin restaurar, un `process.env`
    // escrito, relojes falsos prendidos) se lo filtra al siguiente archivo de su hilo. Se arregla el
    // archivo que filtra; no se vuelve a prender el aislamiento.
    //
    // ⚠ Y EL MÍNIMO IGUAL AL MÁXIMO, que es lo que este repo agrega a truco. Con `isolate=false`, un
    // pool que puede achicarse termina hilos a mitad de corrida y `unit` muere con «Terminating
    // worker thread» después de ~90 archivos, determinista (medido: `--maxWorkers=4 --minWorkers=1`
    // revienta, `--minWorkers=4` pasa). Y ese es justo el caso del CI sin esta línea: con dos núcleos
    // vitest calcula el mínimo como `min(núcleos - 1, máximo)` = 1.
    maxWorkers: WORKERS,
    minWorkers: WORKERS,
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/*.e2e.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: { name: "int", include: ["src/**/*.int.test.ts", "scripts/**/*.int.test.ts"] },
      },
      {
        extends: true,
        test: { name: "e2e", include: ["src/**/*.e2e.test.ts"] },
      },
    ],
  },
});
