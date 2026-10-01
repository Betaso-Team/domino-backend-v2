import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

// UN SERVIDOR DE MENTIRA para los dos scripts de despliegue (portado de games-orchestrator,
// `packages/deploy/test/deploy-fixtures.ts`). Son bash y corren en una máquina a la que la suite no
// llega, así que la tentación es no testearlos, y son justo los archivos donde "listo" puede querer
// decir "corre otra versión". Lo falso: el gestor de procesos, docker, la sonda HTTP y npm. Lo que NO
// es falso: el árbol de releases, el symlink y cómo los scripts miran qué corre de verdad — los
// procesos del pm2 de mentira son procesos REALES con su cwd donde el test lo pide.
const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));

export type Server = {
  root: string;
  release: (name: string) => string;
  /** pm2: `n` procesos reales corriendo desde ese release. */
  runningFrom: (name: string, n?: number) => void;
  /** docker: `n` contenedores corriendo la imagen de ese release. */
  containers: (name: string, n?: number) => void;
  /** docker: el próximo `up` no cambia nada (compose dice que sí y sigue la imagen vieja). */
  upDoesNothing: () => void;
  healthy: (yes: boolean) => void;
  /** Un release que llega DESPUÉS, con el lockfile con el que viaja. */
  upload: (name: string, lock?: string) => void;
  /** Las líneas que anotó el docker de mentira (una por llamada). */
  dockerLog: () => string[];
  installs: () => number;
  /** Otro medio está sirviendo el dominó: pm2 tiene un pid vivo / docker un contenedor corriendo. */
  pm2Serving: () => void;
  dockerServing: () => void;
  writeEnv: (text: string) => void;
  /** Como en el servidor: el script del release NUEVO hace el despliegue. */
  deploy: (script: string, name: string, vars?: Record<string, string>) => Result;
  /** Rollback A TRAVÉS del symlink `current`, lo único que tiene a mano quien opera. */
  rollback: (script: string) => Result;
  /** El atajo ./rollback, SIN UNA SOLA variable: como lo escribe alguien con apuro. */
  blindRollback: () => Result;
};
export type Result = { code: number; out: string };

const alive: Array<ReturnType<typeof spawn>> = [];
const temps: string[] = [];

afterEach(() => {
  for (const p of alive.splice(0)) p.kill();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const points = (s: Server) => readlinkSync(join(s.root, "current")).split("/").pop();
export const readShared = (s: Server, file: string) =>
  readFileSync(join(s.root, "shared", file), "utf8");

export function fakeServer(releases: readonly string[], current: string): Server {
  const root = mkdtempSync(join(tmpdir(), "deploy-"));
  temps.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared", ".env"), "PORT=9105\n");

  const release = (name: string) => join(root, "releases", name);
  const scriptsDir = (name: string) => join(release(name), "scripts", "deploy");
  const upload = (name: string, lock = "{}\n") => {
    // Los scripts viajan ADENTRO del artefacto: cada release trae los suyos, como en el servidor.
    mkdirSync(scriptsDir(name), { recursive: true });
    cpSync(join(SCRIPTS, "lib"), join(scriptsDir(name), "lib"), { recursive: true });
    for (const f of ["deploy-remote.sh", "deploy-docker-remote.sh"]) {
      cpSync(join(SCRIPTS, f), join(scriptsDir(name), f));
    }
    writeFileSync(join(release(name), "ecosystem.config.cjs"), "module.exports = { apps: [] }\n");
    writeFileSync(join(release(name), "compose.yaml"), "services: {}\n");
    writeFileSync(join(release(name), "package-lock.json"), lock);
    // Lo que le dice al script de Docker que la imagen se construye ACÁ y no se carga.
    writeFileSync(join(release(name), "Dockerfile"), "FROM scratch\n");
  };
  for (const name of releases) upload(name);
  symlinkSync(release(current), join(root, "current"));

  const pidsFile = join(root, "pids");
  const healthFile = join(root, "health");
  const psFile = join(root, "containers"); // "<id> <imagen> <running>" por línea
  const dockerLogFile = join(root, "docker.log");
  const noUpFile = join(root, "no-up");
  const npmLog = join(root, "npm.log");
  for (const f of [pidsFile, psFile, dockerLogFile, npmLog]) writeFileSync(f, "");
  writeFileSync(healthFile, "0");

  const stub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub("pm2", `case "$1" in\n  --version) echo 6.0.0 ;;\n  pid) cat ${pidsFile} ;;\nesac\nexit 0`);
  stub("curl", `exit $(cat ${healthFile})`);
  stub("npm", `echo ci >> ${npmLog}`);
  // Un docker chiquito: guarda en un archivo lo que "corre" y contesta `ps`, `inspect` e `image` desde ahí.
  stub(
    "docker",
    `echo "$*" >> ${dockerLogFile}
case "$1" in
  --version) echo "Docker version 27.0.0, build fake" ;;
  ps) awk '{print $1}' ${psFile} ;;
  compose)
    shift
    case " $* " in
      *" version "*) exit 0 ;;
      *" ps "*) awk '{print $1}' ${psFile} ;;
      *" up "*)
        [ -f ${noUpFile} ] && exit 0
        case " $* " in *" domino-server "*|*" domino-server") echo "c1 domino:$RELEASE true" > ${psFile} ;; esac ;;
    esac ;;
  inspect) f="$3"; id="$4"
    case "$f" in
      *Image*) awk -v id="$id" '$1==id{print $2}' ${psFile} ;;
      *Running*) awk -v id="$id" '$1==id{print $3}' ${psFile} ;;
    esac ;;
  image)
    case "$2" in
      inspect) exit 0 ;;
      ls) printf 'local\\nold\\n' ;;
    esac ;;
esac
exit 0`,
  );

  const run = (script: string, args: string[], vars: Record<string, string> | null): Result => {
    const r = spawnSync("bash", [script, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...(vars === null
          ? { APP_NAME: "", INSTANCES: "", APP_ENV: "" }
          : { NODE_BIN: bin, APP_NAME: "test-domino", INSTANCES: "1", ...vars }),
      },
      encoding: "utf8",
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };

  return {
    root,
    release,
    runningFrom(name, n = 1) {
      const pids: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = spawn("sleep", ["30"], { cwd: release(name), stdio: "ignore" });
        alive.push(p);
        if (p.pid) pids.push(p.pid);
      }
      writeFileSync(pidsFile, `${pids.join("\n")}\n`);
    },
    containers(name, n = 1) {
      const lines = Array.from({ length: n }, (_, i) => `c${i + 1} domino:${name} true`);
      writeFileSync(psFile, `${lines.join("\n")}\n`);
    },
    upDoesNothing: () => writeFileSync(noUpFile, ""),
    healthy: (yes) => writeFileSync(healthFile, yes ? "0" : "7"),
    upload,
    dockerLog: () => readFileSync(dockerLogFile, "utf8").split("\n").filter(Boolean),
    installs: () => readFileSync(npmLog, "utf8").split("\n").filter(Boolean).length,
    pm2Serving() {
      const p = spawn("sleep", ["30"], { stdio: "ignore" });
      alive.push(p);
      writeFileSync(pidsFile, `${p.pid}\n`);
    },
    dockerServing: () => writeFileSync(psFile, "c1 domino:other true\n"),
    writeEnv: (text) => writeFileSync(join(root, "shared", ".env"), text),
    deploy: (script, name, vars = {}) => run(join(scriptsDir(name), script), [], vars),
    rollback: (script) =>
      run(join(root, "current", "scripts", "deploy", script), ["--rollback"], {}),
    blindRollback: () => run(join(root, "rollback"), [], null),
  };
}
