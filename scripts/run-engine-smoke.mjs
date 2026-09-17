import { spawnSync } from "node:child_process";

// EL ORQUESTADOR DE LA CERTIFICACIÓN REAL: levanta el stack, corre el smoke del catálogo contra
// servicios de verdad y después el del engine, y limpia pase lo que pase.
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

// Cada smoke de cliente es un contenedor efímero que corre UN comando y se va. `--rm` para no
// dejar contenedores muertos que el `down` tendría que barrer, y `--no-deps` porque el stack ya
// está arriba: sin eso `compose run` levantaría una segunda copia de lo que el cliente declara.
const cliente = (nombre, script) =>
  correr(nombre, ["run", "--rm", "--no-deps", "smoke-client", "npm", "run", script]);

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
  // `engine-smoke.ts` anterior a la Tarea 1: mandaba `entryFeeUcMinor` y el servidor lo rechazaba
  // por claves desconocidas. El modo de falla es cruel porque el error apunta al CONTRATO y no a
  // la imagen, así que se investiga el código que ya está bien.
  if (registrar(correr("construir el cliente", ["build", "smoke-client"])) === 0) {
    if (
      registrar(
        correr("levantar el stack", ["up", "--build", "-d", "redis", "mongo", "domino", "nginx"]),
      ) !== 0
    )
      throw new Error("no se pudo levantar el stack");
    // El smoke del catálogo espera `/ready` por su cuenta: la fase sabe qué necesita y el runner
    // queda tonto. Ver `src/smoke/game-mode-smoke.ts`.
    registrar(cliente("smoke del catálogo", "smoke:game-mode"));
    // EL SMOKE DEL ENGINE, que es el que ya existía: crea una partida 2P contra el catálogo real y
    // la termina por `SCORE`. Corre al final porque necesita el sistema entero sano, y SOLO si el
    // del catálogo pasó: con el catálogo roto este smoke falla también, y su rojo apunta al engine
    // —que está bien— en vez de a la causa. Dos fallas donde hay una sola manda a investigar el
    // archivo equivocado.
    if (código === 0) registrar(cliente("smoke del engine", "smoke:client"));
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
