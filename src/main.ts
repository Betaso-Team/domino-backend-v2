import { listen } from "@colyseus/tools";
import app from "./app.config.js";
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
await listen(app, env.port);
logger.info("servidor escuchando", {
  instancia: env.instanceIndex ?? "única",
  puerto: env.listeningPort,
  anuncia: env.publicAddress ?? "(nada: el cliente vuelve al host al que ya le habló)",
});
