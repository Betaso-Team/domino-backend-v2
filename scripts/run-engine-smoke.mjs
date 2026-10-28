import { spawnSync } from "node:child_process";

// EL ORQUESTADOR DE LA CERTIFICACIÓN REAL: levanta el stack (dos procesos PM2 detrás de nginx, con
// Mongo, Redis y el broker de juegos), juega una partida 2P entera con el cliente del smoke y limpia.
// Son pasos de Compose separados y no un `up --abort-on-container-exit` porque el cliente se
// construye aparte (ver abajo) y corre con `--no-deps` contra el stack que ya está arriba.
//
// EL `finally` NO ES DEFENSIVO, ES EL CONTRATO: una fase que falla y deja el stack arriba hace que
// la corrida siguiente arranque contra los datos de la anterior. Ése es el falso verde más caro de
// un smoke, porque se ve igual que uno sano.

if (process.env.RUN_ENGINE_SMOKE !== "1") {
  console.error("test:deploy requiere RUN_ENGINE_SMOKE=1");
  process.exit(1);
}

const compose = ["compose", "-f", "compose.smoke.yaml"];

const correr = (paso, args) => {
  console.error(`\n=== ${paso} ===`);
  const resultado = spawnSync("docker", [...compose, ...args], { stdio: "inherit" });
  return resultado.status ?? 1;
};

let código = 0;
// SE PROPAGA EL PRIMER CÓDIGO NO CERO Y NO EL ÚLTIMO: el primero es el que explica; los que vienen
// después suelen ser el daño colateral de ése.
const registrar = (estado) => {
  if (código === 0) código = estado;
  return estado;
};

try {
  // ⚠ EL CLIENTE SE CONSTRUYE APARTE Y EXPLÍCITAMENTE, y esto lo encontró la primera corrida real.
  // `up --build` sólo construye los servicios QUE SE NOMBRAN, y el cliente no está entre ellos
  // —lo invoca `compose run`, que NO reconstruye—. El resultado fue una imagen vieja corriendo un
  // `engine-smoke.ts` anterior: mandaba `entryFeeUcMinor` y el servidor lo rechazaba por claves
  // desconocidas. El modo de falla es cruel porque el error apunta al CONTRATO y no a la imagen.
  if (registrar(correr("construir el cliente", ["build", "smoke-client"])) === 0) {
    if (
      registrar(
        correr("levantar el stack", [
          "up",
          "--build",
          "-d",
          "redis",
          "mongo",
          "rabbitmq",
          "domino",
          "nginx",
        ]),
      ) !== 0
    )
      throw new Error("no se pudo levantar el stack");
    // EL SMOKE DEL ENGINE: crea un modo con la llave, juega una partida 2P contra el catálogo real y
    // la termina por `SCORE`. Espera el `/ready` de las dos instancias por su cuenta.
    registrar(
      correr("smoke del engine", [
        "run",
        "--rm",
        "--no-deps",
        "smoke-client",
        "npm",
        "run",
        "smoke:client",
      ]),
    );
  }
} catch (error) {
  console.error(String(error));
  registrar(1);
} finally {
  const limpieza = spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], {
    stdio: "inherit",
  });
  if (limpieza.status !== 0) {
    console.error("no se pudo limpiar el stack del smoke");
    registrar(limpieza.status ?? 1);
  }
}

process.exit(código);
