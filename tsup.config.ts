import { defineConfig } from "tsup";

export default defineConfig({
  // EL ARCHIVO QUE SE EJECUTA (ver la cabecera de `src/main.ts`). `app.config.ts` entra solo,
  // por el grafo de imports; empaquetarlo como segundo `entry` produciría un `dist/` con dos
  // copias del mismo servidor.
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
  // Sin esto, activar minify algún día renombra las clases de error (RuleViolationError,
  // InvariantViolationError) y `.name` deja de sobrevivir — el guardia en
  // engine/errors.test.ts nunca lo vería, porque vitest no minifica. keepNames hace que la
  // garantía aguante sin importar qué se decida sobre minify más adelante.
  keepNames: true,
});
