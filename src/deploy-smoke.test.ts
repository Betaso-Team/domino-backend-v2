import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("smoke del deploy", () => {
  it("mantiene la imagen normal y añade PM2 solo al target smoke", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("FROM runtime AS smoke-server");
    expect(dockerfile).toContain("pm2@7.0.4");
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]');
    expect(dockerfile).toContain('CMD ["pm2-runtime", "ecosystem.config.cjs"]');
  });

  it("rutea ambas instancias y conserva el upgrade websocket", () => {
    const nginx = read("smoke/nginx.conf");
    for (const port of [2567, 2568]) {
      expect(nginx).toContain(`location /${port}/`);
      expect(nginx).toContain(`proxy_pass http://domino:${port}`);
    }
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade");
    expect(nginx).toContain("proxy_set_header Connection $connection_upgrade");
  });

  it("ejecuta dos procesos y un cliente con la flag en un compose aislado", () => {
    const compose = read("compose.smoke.yaml");
    expect(compose).toContain("PM2_INSTANCES: 2");
    expect(compose).toContain("SERVER_ADDRESS: nginx:8080");
    expect(compose).toContain("RUN_ENGINE_SMOKE: 1");
    expect(compose).toContain("target: smoke-server");
    expect(compose).toContain("target: smoke-client");
  });

  it("el wrapper exige flag y siempre declara la limpieza", () => {
    const runner = read("scripts/run-engine-smoke.mjs");
    const processEnv = ["process", "env"].join(".");
    expect(runner).toContain(`${processEnv}.RUN_ENGINE_SMOKE !== "1"`);
    expect(runner).toContain('"--exit-code-from", "smoke-client"');
    expect(runner).toContain('"down", "-v", "--remove-orphans"');
  });
});
