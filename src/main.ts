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
//
// NO PODER ESCUCHAR ES TERMINAL: no hay servidor, así que se dice y se SALE. Sin esto el proceso
// queda vivo para siempre sin atender a nadie, y bajo un supervisor eso es peor de lo que suena:
// pm2 muestra la instancia `online` —su "online" no es salud, la salud la contesta `/ready`— y
// Docker con `restart: unless-stopped` deja el contenedor arriba, que es justo el estado que
// nadie reinicia. Truco lo encontró desplegando (`3d3eb0f`).
//
// Y ACÁ EL AGUJERO ES PEOR QUE EL DE TRUCO, medido sobre `node dist/main.js` con el puerto ya
// ocupado: `listen()` NO RECHAZA. Se queda colgada. Comprobado instrumentando el bundle — no se
// alcanza ningún `catch`, no dispara `uncaughtException` y no dispara `unhandledRejection`; el
// proceso seguía corriendo a los 30 s y hubo que matarlo, con Redis configurado y sin él. La
// causa está en dos archivos de Colyseus que se contradicen: `@colyseus/ws-transport` se
// suscribe al `'error'` del servidor HTTP EN SU CONSTRUCTOR y solo lo IMPRIME
// (`WebSocketTransport.mjs:66`, `debugAndPrintError`), mientras que el `reject` de la promesa lo
// registra `@colyseus/core` ADENTRO del callback de `'listening'` (`Server.mjs:89-91`) — el
// callback que un `EADDRINUSE` justamente nunca dispara. Así que el error se consume, se imprime
// crudo y no llega a nadie: por eso el `.catch()` que truco agregó tampoco cubriría este caso.
//
// POR ESO EL PLAZO, y no un `catch` solo. El `catch` se queda porque es correcto para todo lo que
// SÍ rechaza; el plazo es lo que cubre la familia entera de "nunca llegó a escuchar", que incluye
// la otra que este repo ya tenía documentada: con `REDIS_URL` apuntando a un Redis caído, ioredis
// reintenta para siempre, `matchMaker.setup()` no resuelve y `listen()` tampoco termina
// (§`src/app.config.ts`). Arrancar no es una operación sin plazo.
//
// VEINTE SEGUNDOS, y el número sale de los dos supervisores: pm2 corta a los 10 s por su
// `listen_timeout` y reinicia, así que bajo pm2 este plazo no llega a correr nunca —y está bien:
// ahí ya hay alguien mirando—. El que no tiene plazo es Docker, y es el despliegue por default de
// este repo. El temporizador va `unref`eado para no sostener el event loop de un arranque sano.
const PLAZO_DE_ARRANQUE_MS = 20_000;

const morirSinServidor = (error: unknown): never => {
  logger.error("no se pudo escuchar: esta instancia no tiene servidor", { error: String(error) });
  process.exit(1);
};

const server = await Promise.race([
  listen(app, env.port),
  new Promise<never>((_, rechazar) => {
    setTimeout(
      () => rechazar(new Error(`no llegó a escuchar en ${PLAZO_DE_ARRANQUE_MS} ms`)),
      PLAZO_DE_ARRANQUE_MS,
    ).unref();
  }),
]).catch(morirSinServidor);
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
