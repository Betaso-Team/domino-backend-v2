import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// QUÉ VIAJA AL SERVIDOR, sobre un repo de mentira: en el CI los unitarios corren antes del build, así
// que el `dist/` del repo de verdad todavía no existe. Lo que importa medir es lo que NO puede viajar
// (los secretos de quien empaqueta, los tests) y lo que no puede faltar (los scripts de despliegue).
const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "package-"));
  temps.push(repo);
  cpSync(SCRIPTS, join(repo, "scripts", "deploy"), { recursive: true });
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "ecosystem.config.cjs": "module.exports = {}\n",
    "compose.yaml": "services: {}\n",
    Dockerfile: "FROM scratch\n",
    "src/main.ts": "\n",
    ".gitignore": ".env\ndist\nnode_modules\n",
    ".env": "BETASO_BACKEND_JWT_SECRET=secreto\n",
    "dist/main.js": "\n",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  spawnSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

function pack(repo: string, mode: string): { code: number; files: string[]; out: string } {
  const tgz = join(repo, "out.tgz");
  const r = spawnSync("bash", [join(repo, "scripts/deploy/package-release.sh"), mode, tgz], {
    cwd: repo,
    encoding: "utf8",
  });
  if (r.status !== 0) return { code: r.status ?? -1, files: [], out: `${r.stdout}${r.stderr}` };
  const list = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" });
  return { code: 0, files: list.stdout.split("\n").filter(Boolean), out: r.stdout };
}

describe("el empaquetado del release", () => {
  it("pm2: el bundle, con qué instalar, cómo arrancarlo y los scripts", () => {
    const { code, files } = pack(fakeRepo(), "pm2");

    expect(code).toBe(0);
    for (const f of [
      "package.json",
      "package-lock.json",
      "ecosystem.config.cjs",
      "dist/main.js",
      "scripts/deploy/deploy-remote.sh",
      "scripts/deploy/lib/deploy-common.sh",
    ]) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => f.includes("tests/"))).toBe(false);
    expect(files).not.toContain(".env");
  });

  it("pm2 sin build falla diciendo qué falta", () => {
    const repo = fakeRepo();
    rmSync(join(repo, "dist"), { recursive: true });

    const { code, out } = pack(repo, "pm2");

    expect(code).toBe(1);
    expect(out).toContain("npm run build");
  });

  it("docker: el compose y los scripts; la imagen viaja aparte", () => {
    const { code, files } = pack(fakeRepo(), "docker");

    expect(code).toBe(0);
    expect(files).toContain("compose.yaml");
    expect(files).toContain("scripts/deploy/deploy-docker-remote.sh");
    expect(files.some((f) => f.startsWith("dist"))).toBe(false);
  });

  // `tar .` empaquetaría los secretos de quien lo corre: solo lo versionado o nuevo, nunca lo ignorado.
  it("docker-build: el código, sin lo que .gitignore excluye", () => {
    const { code, files } = pack(fakeRepo(), "docker-build");

    expect(code).toBe(0);
    expect(files).toContain("Dockerfile");
    expect(files).toContain("src/main.ts");
    expect(files).not.toContain(".env");
    expect(files.some((f) => f.startsWith("dist"))).toBe(false);
  });

  it("un medio desconocido falla", () => {
    expect(pack(fakeRepo(), "ftp").code).toBe(1);
  });
});
