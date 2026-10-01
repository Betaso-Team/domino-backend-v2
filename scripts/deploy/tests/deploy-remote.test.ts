import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeServer, points, readShared } from "./deploy-fixtures";

// EL DESPLIEGUE CON PM2, contra un servidor de mentira (ver deploy-fixtures.ts). La versión de truco de
// este script tuvo dos bugs en un día, y los dos costaron un despliegue que decía "listo" mientras
// corría otra versión: el gestor de procesos que no actualiza la ruta del script, y la raíz que salía
// un nivel más arriba cuando el script se invocaba por el symlink. Los dos quedan pineados acá.
const S = "deploy-remote.sh";

describe("el despliegue con pm2", () => {
  // El rollback se pide A TRAVÉS DEL SYMLINK, y ahí era donde el directorio de trabajo mentía: daba
  // la ruta lógica, la raíz salía un nivel arriba y el `.env` compartido no aparecía.
  it("vuelve al otro release cuando se lo pide, invocado por current", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r2-new");
    s.runningFrom("r1-old");

    const { code, out } = s.rollback(S);

    expect(out).not.toContain("falta");
    expect(code).toBe(0);
    expect(points(s)).toBe("r1-old");
  });

  it("sin otro release al que volver, lo dice y falla", () => {
    const s = fakeServer(["r1-only"], "r1-only");
    s.runningFrom("r1-only");

    const { code, out } = s.rollback(S);

    expect(out).toContain("no hay otro release");
    expect(code).toBe(1);
  });

  // Lo que pm2 contestó mal: recargó y siguió corriendo la versión anterior. El script no le cree y
  // mira desde qué directorio corre de verdad cada proceso.
  it("NO lo da por desplegado si lo que corre no es el release nuevo", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r1-old"); // pm2 "recargó" y no cambió nada

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("el reload no tomó la versión nueva");
    expect(code).toBe(1);
  });

  it("cuenta procesos: menos que INSTANCES no es un despliegue sano", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r2-new", 1);

    const { code, out } = s.deploy(S, "r2-new", { INSTANCES: "2" });

    expect(out).toContain("esperaba 2 procesos y hay 1");
    expect(code).toBe(1);
  });

  it("un release que no queda sano devuelve el symlink a la anterior y queda marcado FAILED", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r1-old");
    s.healthy(false);

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("VOLVIENDO");
    expect(points(s)).toBe("r1-old");
    expect(existsSync(join(s.release("r2-new"), "FAILED"))).toBe(true);
    expect(code).toBe(1);
  });

  // EL CASO QUE SE MIDIÓ: el release roto sigue en disco y es el más nuevo, justo el que el rollback
  // elegía. Con la marca, el rollback de emergencia lo saltea.
  it("el rollback saltea un release que falló aunque sea el más nuevo", () => {
    const s = fakeServer(["r1-old", "r2-mid", "r3-broken"], "r2-mid");
    writeFileSync(join(s.release("r3-broken"), "FAILED"), "");
    s.runningFrom("r1-old");

    const { code } = s.rollback(S);

    expect(code).toBe(0);
    expect(points(s)).toBe("r1-old");
  });

  // Volver atrás tiene que ser UN comando. Lo que necesita lo deja escrito el último despliegue.
  it("anota cómo se desplegó, y el rollback después no necesita variables", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r2-new");

    expect(s.deploy(S, "r2-new", { APP_ENV: "dev" }).code).toBe(0);
    const env = readShared(s, "deploy.env");
    expect(env).toContain("APP_NAME=test-domino");
    expect(env).toContain("APP_ENV=dev");

    s.runningFrom("r1-old");
    const { code, out } = s.blindRollback();

    expect(out).not.toContain("falta APP_NAME");
    expect(code).toBe(0);
    expect(points(s)).toBe("r1-old");
  });

  it("toma el puerto 2567 cuando shared/.env no trae PORT", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.writeEnv("APP_ENV=dev\n");
    s.runningFrom("r2-new");

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("puertos 2567..2567");
    expect(code).toBe(0);
  });

  it("enlaza el .env compartido en la raíz del release, de donde lo lee el dominó", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r2-new");

    expect(s.deploy(S, "r2-new").code).toBe(0);

    expect(readFileSync(join(s.release("r2-new"), ".env"), "utf8")).toContain("PORT=9105");
  });

  it("escribe los atajos ./logs, ./restart y ./rollback", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r2-new");

    expect(s.deploy(S, "r2-new").code).toBe(0);

    expect(readFileSync(join(s.root, "logs"), "utf8")).toContain('pm2 logs "test-domino" --raw');
    expect(readFileSync(join(s.root, "restart"), "utf8")).toContain("scripts/deploy/");
    expect(readFileSync(join(s.root, "restart"), "utf8")).toContain("--restart");
    expect(readFileSync(join(s.root, "rollback"), "utf8")).toContain("--rollback");
  });

  it("conserva el release que corre y el anterior, y barre el resto", () => {
    const s = fakeServer(["r0-ancient", "r1-old"], "r1-old");
    s.upload("r2-new");
    s.runningFrom("r2-new");

    expect(s.deploy(S, "r2-new").code).toBe(0);

    expect(() => readFileSync(join(s.release("r0-ancient"), "package-lock.json"))).toThrow();
    expect(readFileSync(join(s.release("r1-old"), "package-lock.json"), "utf8")).toBe("{}\n");
  });

  it("se niega a desplegar mientras Docker sirve el dominó: mismo puerto, un medio a la vez", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.dockerServing();

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("Docker está sirviendo");
    expect(code).toBe(1);
    expect(points(s)).toBe("r1-old");
  });

  // Reinstalar lo que no cambió era un tercio del despliegue. Lo que no puede pasar es lo contrario:
  // reusar módulos que ya no corresponden al lockfile.
  describe("las dependencias", () => {
    const withR2Deployed = (lockOfR2: string) => {
      const s = fakeServer(["r1"], "r1");
      s.upload("r2", lockOfR2);
      s.runningFrom("r2");
      expect(s.deploy(S, "r2").code).toBe(0);
      return s;
    };

    it("con el mismo lockfile, reusa las del release anterior sin instalar", () => {
      const s = withR2Deployed("lock-a");
      writeFileSync(join(s.release("r2"), "node_modules", "mark"), "from r2");
      s.upload("r3", "lock-a");
      s.runningFrom("r3");

      const { code, out } = s.deploy(S, "r3");

      expect(code).toBe(0);
      expect(out).toContain("se reusan las de r2");
      expect(s.installs()).toBe(1);
      expect(readFileSync(join(s.release("r3"), "node_modules", "mark"), "utf8")).toBe("from r2");
    });

    it("si el lockfile cambió, instala de cero", () => {
      const s = withR2Deployed("lock-a");
      s.upload("r3", "lock-b");
      s.runningFrom("r3");

      const { code, out } = s.deploy(S, "r3");

      expect(code).toBe(0);
      expect(out).not.toContain("se reusan");
      expect(s.installs()).toBe(2);
    });
  });

  // Las notas son un heredoc: uno sin comillas ejecutaría lo que cite un acento grave de sus comentarios.
  it("escribir las notas del despliegue no ejecuta nada de lo que dicen sus comentarios", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    s.runningFrom("r2-new");

    const { code, out } = s.deploy(S, "r2-new");

    expect(code).toBe(0);
    expect(out).not.toContain("line ");
    expect(readShared(s, "deploy.env")).toContain("`APP_ENV`");
  });
});
