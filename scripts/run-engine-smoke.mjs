import { spawnSync } from "node:child_process";

if (process.env.RUN_ENGINE_SMOKE !== "1") {
  console.error("test:deploy requiere RUN_ENGINE_SMOKE=1");
  process.exit(1);
}

const compose = ["compose", "-f", "compose.smoke.yaml"];
const up = spawnSync(
  "docker",
  [...compose, "up", "--build", "--abort-on-container-exit", "--exit-code-from", "smoke-client"],
  { stdio: "inherit" },
);
const down = spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], {
  stdio: "inherit",
});

if (down.status !== 0) console.error("no se pudo limpiar el stack del smoke");
const upStatus = up.status ?? 1;
process.exit(upStatus === 0 && down.status !== 0 ? 1 : upStatus);
