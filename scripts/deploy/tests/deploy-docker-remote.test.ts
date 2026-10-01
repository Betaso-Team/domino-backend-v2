import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeServer, points, readShared } from "./deploy-fixtures";

// EL DESPLIEGUE CON DOCKER, la alternativa a pm2, contra el mismo servidor de mentira. Tiene que dar las
// mismas garantías: no le cree a lo que compose dice que hizo, vuelve solo cuando el release nuevo no
// queda sano, y se puede volver atrás sin argumentos.
const S = "deploy-docker-remote.sh";

// Un release que viaja con su imagen, como lo manda el CI (el `docker load` de mentira no la lee).
const withImage = (s: ReturnType<typeof fakeServer>, name: string) =>
  writeFileSync(join(s.release(name), "image.tar.gz"), "fake");

describe("el despliegue con Docker", () => {
  it("carga la imagen del CI y la etiqueta con el id del release, que es lo que necesita el rollback", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");
    s.containers("r1-old");

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("cargando la imagen");
    expect(s.dockerLog()).toContain("tag domino:ci domino:r2-new");
    expect(code).toBe(0);
    expect(points(s)).toBe("r2-new");
  });

  it("construye en el servidor cuando el release no trae imagen sino el código", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("construyendo la imagen en el servidor");
    expect(s.dockerLog().some((l) => l.includes(" build domino-server"))).toBe(true);
    expect(code).toBe(0);
  });

  it("levanta solo el dominó del servidor, sin Mongo, Redis ni RabbitMQ del compose", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");

    expect(s.deploy(S, "r2-new").code).toBe(0);

    const ups = s.dockerLog().filter((l) => l.includes(" up "));
    expect(ups.length).toBeGreaterThan(0);
    for (const up of ups) {
      expect(up).toContain("--no-deps");
      expect(up.endsWith("domino-server")).toBe(true);
    }
  });

  // El `domino` de desarrollo del compose exige `./.env`, y compose lo valida aunque no se lo levante.
  it("enlaza el .env compartido en el release, sin el cual compose no arranca", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");

    expect(s.deploy(S, "r2-new").code).toBe(0);

    expect(readFileSync(join(s.release("r2-new"), ".env"), "utf8")).toContain("PORT=9105");
  });

  it("NO lo da por desplegado si los contenedores siguen corriendo la imagen vieja", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");
    s.containers("r1-old");
    s.upDoesNothing(); // compose dice que sí y no cambia nada

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("el reload no tomó la versión nueva");
    expect(code).toBe(1);
  });

  // Varias instancias necesitan que el proxy rutee cada partida a SU proceso, y eso es de pm2.
  it("se niega a más de una instancia, antes de tocar nada", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");

    const { code, out } = s.deploy(S, "r2-new", { INSTANCES: "2" });

    expect(out).toContain("UNA instancia");
    expect(code).toBe(1);
    expect(points(s)).toBe("r1-old");
  });

  it("un release que no queda sano devuelve el symlink a la anterior", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");
    s.healthy(false);

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("VOLVIENDO");
    expect(points(s)).toBe("r1-old");
    expect(code).toBe(1);
  });

  it("anota cómo se desplegó, y el rollback después no necesita variables", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");

    expect(s.deploy(S, "r2-new", { APP_ENV: "dev" }).code).toBe(0);
    expect(readShared(s, "deploy.env")).toContain("APP_NAME=test-domino");

    const { code, out } = s.blindRollback();

    expect(out).not.toContain("falta APP_NAME");
    expect(code).toBe(0);
    expect(points(s)).toBe("r1-old");
  });

  it("se niega a desplegar mientras pm2 sirve el dominó: un medio a la vez", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");
    s.pm2Serving();

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("pm2 está sirviendo");
    expect(code).toBe(1);
    expect(points(s)).toBe("r1-old");
  });

  it("falla cuando el release no trae ni imagen ni Dockerfile", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    // `upload` siempre escribe un Dockerfile: se saca para modelar un release pelado.
    rmSync(join(s.release("r2-new"), "Dockerfile"));

    const { code, out } = s.deploy(S, "r2-new");

    expect(out).toContain("ni image.tar.gz ni Dockerfile");
    expect(code).toBe(1);
  });

  it("escribe un ./logs que sigue al servicio del servidor", () => {
    const s = fakeServer(["r1-old", "r2-new"], "r1-old");
    withImage(s, "r2-new");

    expect(s.deploy(S, "r2-new").code).toBe(0);

    const logs = readFileSync(join(s.root, "logs"), "utf8");
    expect(logs).toContain("COMPOSE_PROFILES=server");
    expect(logs).toContain('"domino-server"');
  });
});
