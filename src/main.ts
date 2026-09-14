import { listen } from "@colyseus/tools";
import app from "./app.config.js";
import { shutdown } from "./di-container.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

// EL ARCHIVO QUE SE EJECUTA, y está separado del que se IMPORTA (`app.config.ts`, que compone
// las dos superficies y del que cuelga la suite entera). Se llamaba `index.ts` y el rename no
// es cosmético: es dónde puede vivir el apagado ordenado.
//
// Registrar manejadores de señal, de `uncaughtException` y de `message` desde un módulo que
// importan cuarenta y cinco archivos de test dejaría a cada worker de vitest con un apagado
// propio compitiendo por el proceso. Acá no llega ningún test, así que el apagado puede ser
// del proceso sin pelearse con nadie.
//
// Truco llegó a esta misma forma por un camino peor (`be06148`): allá `index.ts` sí escuchaba,
// pero detrás de una guarda que comparaba `import.meta.url` contra `process.argv[1]` — y bajo
// pm2 en modo fork ese `argv[1]` es el envoltorio de pm2 y no el script, así que el servidor
// nunca escuchaba y pm2 daba la instancia por levantada al vencer su `listen_timeout`. El
// dominó nunca tuvo esa guarda, así que no hay bug que arreglar: lo que se porta es la forma
// —dos archivos y ninguna comparación—, no el parche.
//
// El nombre está escrito en cuatro lugares que no se importan entre sí (el bundler, los dos
// scripts de npm, el `CMD` de la imagen y el `script` de pm2) y ninguno rompe el gate al
// desincronizarse. Lo pinea `src/entrypoint.test.ts`.

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: String(reason) });
});

// A `listen()` SE LE PASA EL PUERTO BASE, y acá está la trampa que solo se ve corriéndolo:
// `@colyseus/tools` le suma `NODE_APP_INSTANCE` ADENTRO (`build/index.mjs`: `port +=
// processNumber`, medido sobre la 0.18.3 instalada). Sumárselo antes lo contaría dos veces —con
// base 2567 la instancia 1 ataría 2569— y el síntoma es un puerto al que no llega nadie.
//
// Lo que se LOGUEA es el otro: el puerto efectivo, junto con la dirección que esta instancia
// anuncia. Es para que un desfase entre las dos cosas se vea en el arranque y no cuando un cliente
// no conecta — que es donde este error aparece, porque el servidor equivocado contesta con total
// confianza que esa sala no es suya.
//
// El `process.send('ready')` que pm2 espera (`wait_ready`) NO se manda acá: ya lo manda
// `@colyseus/tools` al final de su `listen()`, y mandarlo dos veces sería ruido, no una red.
const server = await listen(app, env.port);
logger.info("servidor escuchando", {
  instancia: env.instanceIndex ?? "única",
  puerto: env.listeningPort,
  anuncia: env.publicAddress ?? "(nada: el cliente vuelve al host al que ya le habló)",
});

// EL APAGADO ORDENADO, y la razón es de plata: una partida que muere sin veredicto es un
// reembolso que nunca se anuncia. El orden es el contrato:
//
//   1. EL EMPAREJAMIENTO Y LAS SALAS, con `server.gracefullyShutdown(false)`. Adentro,
//      `matchMaker.gracefullyShutdown()` primero pone el proceso en SHUTTING_DOWN —o sea que
//      deja de aceptar salas nuevas: abrir una partida mientras se apaga es crear una sala que
//      nadie va a poder terminar— y RECIÉN DESPUÉS dispone las que hay. El `false` es "no
//      salgas vos": el `process.exit` lo damos acá, cuando terminó todo lo demás.
//   2. LO QUE LAS SALAS PRODUJERON, con `shutdown()` del container: drenar el historial y
//      cerrar Mongo, en ese orden (§`src/di-container.ts`). Va DESPUÉS del paso 1 porque el
//      último lote de cada partida lo escribe su sala al disponerse.
//
// Redis lo cierra el paso 1: Colyseus apaga `presence` y `driver` adentro de su
// `gracefullyShutdown`, y hacerlo también acá lo cerraría dos veces.
const drain = async (): Promise<void> => {
  const empezó = Date.now();
  await server.gracefullyShutdown(false);
  await shutdown();
  logger.info("apagado ordenado completo", { ms: Date.now() - empezó });
};

// SE DRENA UNA SOLA VEZ, venga por donde venga. Y viene por DOS caminos distintos, que es el
// hallazgo que solo aparece corriéndolo bajo pm2.
let drenando = false;
const apagar = (code = 0): void => {
  if (drenando) return;
  drenando = true;
  void drain()
    .catch((error) => logger.error("apagado ordenado: falló el drenado", { error: String(error) }))
    .finally(() => process.exit(code));
};

// PRIMER CAMINO: las mismas señales que atendía Colyseus, repuestas para no perder ninguna al
// tomarle el apagado (§`gracefullyShutdown: false` en `app.config.ts`). `once` y no `on`: un
// segundo SIGTERM durante el drenado no tiene que reiniciarlo.
for (const signal of ["SIGTERM", "SIGINT", "SIGUSR2"] as const)
  process.once(signal, () => apagar());

// SEGUNDO CAMINO, Y ES EL DE PRODUCCIÓN: pm2 con `shutdown_with_message` manda un MENSAJE
// `shutdown`, NO una señal. Sin esta rama el drenado no correría en ningún `pm2 reload` —o sea
// en ningún deploy— y el síntoma sería silencioso: salas que nunca se disponen y el último lote
// de historial de cada una perdido, sin un solo error en el log.
process.on("message", (message) => {
  if (message === "shutdown") apagar();
});

// LA OTRA RED QUE COLYSEUS PONÍA. Sin un manejador, una excepción sin atrapar mata el proceso
// en el acto, y matarlo sin drenar es perder los desenlaces en vuelo. Se drena y se sale con 1,
// que es lo que le dice al supervisor que esto no fue un apagado pedido.
process.on("uncaughtException", (error) => {
  logger.error("excepción sin atrapar: drenando y saliendo", { error: String(error) });
  apagar(1);
});
