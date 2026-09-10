import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // `forks` (el default) rompe: @colyseus/tools usa process.send y choca con su IPC.
    pool: "threads",
    testTimeout: 15_000,
  },
});
