import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
