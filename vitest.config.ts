import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
        test: { name: "int", include: ["src/**/*.int.test.ts"] },
      },
      {
        extends: true,
        test: { name: "e2e", include: ["src/**/*.e2e.test.ts"] },
      },
    ],
  },
});
