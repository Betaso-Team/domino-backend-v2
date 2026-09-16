import { spawnSync } from "node:child_process";

// EL ORQUESTADOR DE LA CERTIFICACIÓN REAL. Dejó de ser un `compose up --abort-on-container-exit`
// porque el escenario que justifica el outbox entero —broker caído, evento encolado, broker de
// vuelta, evento entregado— exige APAGAR Y PRENDER RabbitMQ en el medio, y eso no se puede
// expresar con una sola invocación de Compose.
//
// ⚠ `--no-deps` EN TODAS LAS FASES DE CLIENTE, y es la línea que más fácil se borra sin entender.
// `compose run` levanta por default los servicios de los que el cliente depende: sin esto, la fase
// que certifica que Rabbit está CAÍDO lo volvería a prender antes de medir, y pasaría en verde
// midiendo exactamente lo contrario de lo que dice medir.
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

// Cada fase del catálogo es un contenedor efímero que corre UN comando y se va. `--rm` para no
// dejar contenedores muertos que el `down` tendría que barrer.
const fase = (nombre) =>
  correr(`fase ${nombre}`, [
    "run",
    "--rm",
    "--no-deps",
    "smoke-client",
    "npm",
    "run",
    "smoke:game-mode",
    "--",
    nombre,
  ]);

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
    // La fase `normal` espera `/ready` por su cuenta: la fase sabe qué necesita y el runner queda
    // tonto. Ver `src/smoke/game-mode-smoke.ts`.
    if (registrar(fase("normal")) === 0) {
      // RABBIT ABAJO. `stop` y no `down`: el volumen y la cola durable tienen que sobrevivir, que
      // es lo que hace que `recover` pueda encontrar lo que se encoló mientras no estaba.
      if (registrar(correr("apagar rabbit", ["stop", "rabbitmq"])) === 0) {
        registrar(fase("enqueue"));
      }
      // RABBIT DE VUELTA, pase lo que pase con `enqueue`: dejarlo apagado haría que el smoke del
      // engine —y cualquier diagnóstico posterior— corriera contra un sistema a medias.
      if (registrar(correr("prender rabbit", ["start", "rabbitmq"])) === 0) {
        // `up --wait` respeta el healthcheck del servicio: sin esto `recover` arrancaría contra un
        // broker que todavía no atiende y el rojo sería un timeout que no dice nada.
        registrar(correr("esperar rabbit sano", ["up", "-d", "--wait", "rabbitmq"]));
        registrar(fase("recover"));
      }
    }
    // EL SMOKE DEL ENGINE, que es el que ya existía: crea una partida 2P contra el catálogo real y
    // la termina por `SCORE`. Corre al final porque necesita el sistema entero sano, y SOLO si las
    // fases del catálogo pasaron: con el catálogo roto este smoke falla también, y su rojo apunta
    // al engine —que está bien— en vez de a la causa. Dos fallas donde hay una sola es peor que
    // una, porque la segunda manda a investigar el archivo equivocado.
    if (código === 0)
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
