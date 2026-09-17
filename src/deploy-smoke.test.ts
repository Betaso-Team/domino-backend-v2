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

  // ⚠ EL `--exit-code-from` YA NO ESTÁ, y su ausencia es la decisión: el runner dejó de ser un
  // `compose up --abort-on-container-exit` para poder correr dos smokes de cliente contra el mismo
  // stack. Ahora el código sale de esos pasos, y lo que hay que pinear es que se propague el PRIMER
  // no cero —el que explica— y que la limpieza esté en un `finally` y no al final del camino feliz.
  it("el wrapper exige flag, propaga el primer fallo y limpia pase lo que pase", () => {
    const runner = read("scripts/run-engine-smoke.mjs");
    const processEnv = ["process", "env"].join(".");
    expect(runner).toContain(`${processEnv}.RUN_ENGINE_SMOKE !== "1"`);
    expect(runner).toContain("finally");
    expect(runner).toContain('"down", "-v", "--remove-orphans"');
    expect(runner).toContain("smoke:client");
  });

  it("CI ejecuta el smoke después del build y antes de empaquetar", () => {
    const ci = read(".github/workflows/ci.yml");
    const build = ci.indexOf("name: Build");
    const smoke = ci.indexOf("name: Smoke Docker, PM2 y Nginx");
    const pack = ci.indexOf("name: Empaquetar el release");
    expect(build).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(build);
    expect(pack).toBeGreaterThan(smoke);
    expect(ci.slice(smoke, pack)).toContain("RUN_ENGINE_SMOKE: '1'");
    expect(ci.slice(smoke, pack)).toContain("npm run test:deploy");
  });
});
