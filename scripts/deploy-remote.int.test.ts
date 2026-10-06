import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// EL DESPLIEGUE, contra un servidor de mentira. Es bash y corre en una máquina que la suite no
// alcanza, así que la tentación es no testearlo — y es justo el archivo que en truco tuvo dos bugs en
// un día: pm2 sin actualizar la ruta del script, y la raíz saliendo un nivel arriba al invocarlo por
// el symlink. Los dos costaron un deploy que decía "listo" mientras corría otra versión. Portado de
// truco (`43751dc`, `d7a761e`, `32d83de`).
//
// Lo único de mentira es pm2, la sonda HTTP y npm. Lo que NO es de mentira es lo que se rompió: el
// árbol de releases, el symlink y cómo el script chequea qué corre de verdad — así que los procesos
// del pm2 de mentira son procesos REALES con su directorio de trabajo donde el test quiere.
//
// ⚠ SÓLO EN LINUX, y no lo disimula: el script lee `/proc/<pid>/cwd` y usa `mv -Tf` y `readlink -f`,
// que son de GNU/Linux (lo dice su encabezado). En Windows o macOS se saltea; el CI corre en Linux.
const SCRIPT = fileURLToPath(new URL("./deploy-remote.sh", import.meta.url));

interface Server {
  readonly root: string;
  release(name: string): string;
  runningFrom(dir: string, count?: number): void;
  healthy(ok: boolean): void;
  // Un release que llega DESPUÉS, con el lockfile con el que viaja: un deploy barre lo que hay en disco.
  upload(name: string, lock?: string): void;
  installs(): number;
  // Como en producción: el deploy corre el script del release NUEVO, y el rollback se pide por el
  // symlink `current`, que es lo único que un operador tiene a mano.
  deploy(name: string): { code: number; out: string };
  rollback(): { code: number; out: string };
  // Los atajos, SIN variables: como los teclea alguien apurado.
  shortcut(name: "rollback" | "restart"): { code: number; out: string };
}

const alive: ChildProcess[] = [];
const temporary: string[] = [];

afterEach(() => {
  for (const child of alive.splice(0)) child.kill();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeServer(releases: readonly string[], current: string): Server {
  const root = mkdtempSync(join(tmpdir(), "domino-deploy-"));
  temporary.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "shared"), { recursive: true });
  writeFileSync(join(root, "shared", ".env"), "PORT=9105\n");

  const release = (name: string) => join(root, "releases", name);
  const upload = (name: string, lock = "{}\n") => {
    mkdirSync(join(release(name), "scripts"), { recursive: true });
    // El script viaja ADENTRO del artefacto: cada release tiene el suyo, como en producción.
    cpSync(SCRIPT, join(release(name), "scripts", "deploy-remote.sh"));
    writeFileSync(join(release(name), "ecosystem.config.cjs"), "module.exports = { apps: [] }\n");
    writeFileSync(join(release(name), "package-lock.json"), lock);
  };
  for (const name of releases) upload(name);
  symlinkSync(release(current), join(root, "current"));

  // Los pids que va a contestar el pm2 de mentira, y si la sonda de mentira dice que sí.
  const pidsFile = join(root, "pids");
  const healthFile = join(root, "health");
  const pm2Log = join(root, "pm2.log");
  writeFileSync(pidsFile, "");
  writeFileSync(healthFile, "0");
  writeFileSync(pm2Log, "");

  const stub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  // Anota con qué RELEASE se lo arrancó: es lo que `ecosystem.config.cjs` le pasa al proceso.
  stub(
    "pm2",
    `case "$1" in\n  --version) echo 6.0.0 ;;\n  pid) cat ${pidsFile} ;;\n  start|startOrReload) echo "$1 RELEASE=$RELEASE" >> ${pm2Log} ;;\nesac\nexit 0`,
  );
  stub("curl", `exit $(cat ${healthFile})`);
  const npmLog = join(root, "npm.log");
  writeFileSync(npmLog, "");
  stub("npm", `echo ci >> ${npmLog}`);

  const run = (script: string, args: string[] = [], withVariables = true) => {
    const result = spawnSync("bash", [script, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ...(withVariables
          ? { NODE_BIN: bin, PM2_APP_NAME: "domino-v2-test", PM2_INSTANCES: "1" }
          : { NODE_BIN: "", PM2_APP_NAME: "", PM2_INSTANCES: "" }),
      },
      encoding: "utf8",
    });
    return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  };

  return {
    root,
    release,
    runningFrom(dir, count = 1) {
      const pids: number[] = [];
      for (let i = 0; i < count; i++) {
        // Un proceso real con su directorio de trabajo ahí: es lo que el script va a leer.
        const child = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
        alive.push(child);
        if (child.pid) pids.push(child.pid);
      }
      writeFileSync(pidsFile, `${pids.join("\n")}\n`);
    },
    healthy(ok) {
      writeFileSync(healthFile, ok ? "0" : "7");
    },
    upload,
    installs: () => readFileSync(npmLog, "utf8").split("\n").filter(Boolean).length,
    deploy: (name) => run(join(release(name), "scripts", "deploy-remote.sh")),
    rollback: () => run(join(root, "current", "scripts", "deploy-remote.sh"), ["--rollback"]),
    shortcut: (name) => run(join(root, name), [], false),
  };
}

const pointsTo = (server: Server) => readlinkSync(join(server.root, "current")).split("/").pop();
const pm2Calls = (server: Server) => readFileSync(join(server.root, "pm2.log"), "utf8");

describe.skipIf(process.platform !== "linux")("el despliegue en el servidor", () => {
  // EL ROLLBACK SE PIDE POR EL SYMLINK, y ahí el directorio de trabajo mentía: devolvía la ruta
  // lógica, así que la raíz salía un nivel arriba y el script no encontraba el `.env` compartido.
  it("vuelve al otro release cuando se lo piden, invocado a través de current", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r2-nueva");
    server.runningFrom(server.release("r1-vieja"));

    const { code, out } = server.rollback();

    expect(out).not.toContain("falta");
    expect(code).toBe(0);
    expect(pointsTo(server)).toBe("r1-vieja");
  });

  it("sin otro release al que volver, lo dice y falla", () => {
    const server = fakeServer(["r1-sola"], "r1-sola");
    server.runningFrom(server.release("r1-sola"));

    const { code, out } = server.rollback();

    expect(out).toContain("no hay otro release");
    expect(code).toBe(1);
  });

  // Lo que pm2 contestó mal: recargó y siguió corriendo la versión anterior. El script no le cree y
  // mira desde qué directorio corre cada proceso.
  it("si lo que corre no es el release nuevo, NO lo da por desplegado", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r1-vieja");
    server.runningFrom(server.release("r1-vieja"));

    const { code, out } = server.deploy("r2-nueva");

    expect(out).toContain("el reload no tomó la versión nueva");
    expect(code).toBe(1);
  });

  it("un release que no queda sano devuelve el symlink a la versión anterior y se marca", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r1-vieja");
    server.runningFrom(server.release("r1-vieja"));
    server.healthy(false);

    const { code, out } = server.deploy("r2-nueva");

    expect(out).toContain("VOLVIENDO");
    expect(pointsTo(server)).toBe("r1-vieja");
    expect(existsSync(join(server.release("r2-nueva"), "FAILED"))).toBe(true);
    expect(code).toBe(1);
  });

  // ⚠ EL DEFECTO QUE TRUCO TODAVÍA TIENE: el release roto sigue en disco y es el más nuevo, así que
  // un rollback que eligiera "el más nuevo que no corre" se iba de cabeza a la versión que acababa
  // de fallar.
  it("el rollback de emergencia saltea el release que falló", () => {
    const server = fakeServer(["r1", "r2", "r3-rota"], "r2");
    writeFileSync(join(server.release("r3-rota"), "FAILED"), "");
    server.runningFrom(server.release("r1"));

    const { code } = server.rollback();

    expect(code).toBe(0);
    expect(pointsTo(server)).toBe("r1");
  });

  // VOLVER ATRÁS TIENE QUE SER UN COMANDO. Lo que necesita lo anota el último despliegue.
  it("el despliegue deja anotado cómo volver, y el atajo de rollback no necesita variables", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r1-vieja");
    server.runningFrom(server.release("r2-nueva"));

    expect(server.deploy("r2-nueva").code).toBe(0);
    expect(readFileSync(join(server.root, "shared", "deploy.env"), "utf8")).toContain(
      "PM2_APP_NAME=domino-v2-test",
    );

    server.runningFrom(server.release("r1-vieja"));
    const { code, out } = server.shortcut("rollback");

    expect(out).not.toContain("falta PM2_APP_NAME");
    expect(code).toBe(0);
    expect(pointsTo(server)).toBe("r1-vieja");
  });

  it("el atajo de restart recrea la app sin cambiar de versión", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r1-vieja");
    server.runningFrom(server.release("r2-nueva"));
    expect(server.deploy("r2-nueva").code).toBe(0);

    const { code, out } = server.shortcut("restart");

    expect(code).toBe(0);
    expect(out).toContain("recreando domino-v2-test desde r2-nueva");
    expect(pointsTo(server)).toBe("r2-nueva");
  });

  // CADA LÍNEA DE LOG DICE DE QUÉ VERSIÓN SALIÓ, y el que lo sabe es el deploy: se lo pasa a pm2,
  // que se lo pasa al proceso por `ecosystem.config.cjs`.
  it("arranca el proceso diciéndole qué release es", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r1-vieja");
    server.runningFrom(server.release("r2-nueva"));

    expect(server.deploy("r2-nueva").code).toBe(0);

    expect(pm2Calls(server)).toContain("RELEASE=r2-nueva");
  });

  // Los atajos son heredocs que EXPANDEN variables: lo que tienen que dejar es el nombre de la app
  // ya resuelto y `$@` todavía literal, para que los argumentos lleguen a pm2.
  it("el atajo de logs queda con la app resuelta y los argumentos intactos", () => {
    const server = fakeServer(["r1-vieja", "r2-nueva"], "r1-vieja");
    server.runningFrom(server.release("r2-nueva"));

    const { code, out } = server.deploy("r2-nueva");
    const logs = readFileSync(join(server.root, "logs"), "utf8");

    expect(code).toBe(0);
    expect(out).not.toContain("line ");
    expect(logs).toContain('pm2 logs "domino-v2-test" --raw "$@"');
    expect(logs).toContain("pino-pretty");
  });

  // Reinstalar lo que no cambió era un tercio del deploy. Lo que no puede pasar es lo contrario:
  // reusar módulos que ya no coinciden con el lockfile.
  describe("las dependencias", () => {
    const withR2Deployed = (lockOfR2: string) => {
      const server = fakeServer(["r1"], "r1");
      server.upload("r2", lockOfR2);
      server.runningFrom(server.release("r2"));
      expect(server.deploy("r2").code).toBe(0);
      return server;
    };

    it("con el mismo lockfile, se reusan las del release anterior sin instalar", () => {
      const server = withR2Deployed("lock-a");
      writeFileSync(join(server.release("r2"), "node_modules", "marca"), "de r2");
      server.upload("r3", "lock-a");
      server.runningFrom(server.release("r3"));

      const { code, out } = server.deploy("r3");

      expect(code).toBe(0);
      expect(out).toContain("se reusan las de r2");
      expect(server.installs()).toBe(1);
      expect(readFileSync(join(server.release("r3"), "node_modules", "marca"), "utf8")).toBe(
        "de r2",
      );
    });

    it("si el lockfile cambió, instala de cero", () => {
      const server = withR2Deployed("lock-a");
      server.upload("r3", "lock-b");
      server.runningFrom(server.release("r3"));

      const { code, out } = server.deploy("r3");

      expect(code).toBe(0);
      expect(out).not.toContain("se reusan");
      expect(server.installs()).toBe(2);
    });
  });
});
