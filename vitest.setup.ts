import "reflect-metadata";
import dotenv from "dotenv";

// EL `.env` NO EXISTE PARA LA SUITE, y esta línea es lo único que puede garantizarlo.
//
// Hay DOS cargadores de `.env` en este repo y solo uno es nuestro. El nuestro —`src/env.ts`
// con `process.loadEnvFile()`— se guarda solo, mirando `VITEST`. El otro es
// `@colyseus/tools`, que hace `import "./loadenv.mjs"` en la primera línea de su bundle
// (`node_modules/@colyseus/tools/build/index.mjs:2`) y ahí llama a `dotenv.config()`
// (`build/loadenv.mjs`, `loadEnvFile([".env.${NODE_ENV}", ".env"])`).
//
// Y contra ése NO HAY ORDEN QUE NOS SALVE: este archivo es un `setupFile`, o sea que corre
// ANTES de que se evalúen los imports del archivo de test, y `@colyseus/tools` entra por
// `src/app.config.ts` —el composition root que importan los tests de sala, los e2e y el de la
// raíz HTTP—. O sea que dotenv inyecta el `.env` del desarrollador DESPUÉS de los `delete` de
// más abajo y ANTES de que `src/env.ts` lea `process.env`. El borrado quedaba anulado.
//
// No es hipotético: medido con un `.env` local que tenía `MONGO_URI` y `REDIS_URL`, la suite
// pasó de 311 verdes a 18 tests rojos en 6 archivos, y vitest lo imprimía en cada archivo
// (`✅ .env loaded.`) sin que nadie lo leyera.
//
// SE DESACTIVA LA FUNCIÓN, no se borran variables después: un `.env` no trae solo esas dos.
// Trae `TURN_TIMEOUT_MS`, trae `SERVER_ADDRESS`, y puede traer `WRITE_GOLDEN=1` — que es
// `npm test` REESCRIBIENDO los fixtures golden en vez de medir contra ellos. Los valores de la
// suite los pone este archivo y ahí terminan.
//
// `dotenv` no se declara en `package.json` a propósito, y no es un descuido: no es una
// dependencia nuestra sino LA QUE `@colyseus/tools` YA TRAE, y es exactamente esa instancia la
// que hay que desactivar. Declararla dejaría que npm resuelva una segunda copia y el parche
// apuntaría a la que nadie usa. Verificado: hay UN solo `node_modules/dotenv` y
// `@colyseus/tools` no tiene `node_modules` propio.
dotenv.config = () => ({ parsed: {} });

// src/env.ts valida el entorno al importarse y lanza si falta JWT_SECRET (ver su cabecera).
// Estos defaults evitan que cualquier test que importe env.ts — directa o transitivamente —
// explote solo por correr sin variables configuradas.
process.env.NODE_ENV ??= "test";
process.env.JWT_SECRET ??= "test-secret-do-not-use-in-production";
// Sin esto la API interna no se registra (fail closed) y sus tests e2e no tendrían
// ruta contra la cual medir. El caso "sin llave" se prueba aparte, sin servidor.
process.env.INTERNAL_API_KEY ??= "test-internal-key-do-not-use-in-production";
// SE BORRA, no se ignora, y es la única variable que este archivo saca en vez de poner.
// La presencia de `MONGO_URI` es lo que elige la implementación del historial en el
// composition root (ver src/di-container.ts), así que un desarrollador que la tenga
// exportada en su shell —porque corre el truco al lado, o el compose de otro proyecto—
// haría que `npm test` cableara Mongo y que los cuarenta archivos de la suite leyeran y
// escribieran el historial en una base de verdad: lecturas de otra corrida, escrituras
// asíncronas que llegan tarde a las aserciones, y ningún borrado entre archivos.
//
// La suite del dominó no depende de NINGÚN servicio externo y esto es lo que lo garantiza:
// sin esta línea la propiedad no dependería del repo sino del entorno de quien lo corre.
// El adaptador de Mongo se prueba con un doble del driver
// (src/features/match/network/transports/mongo-history.test.ts).
delete process.env.MONGO_URI;
// SE BORRA POR LA MISMA RAZÓN, y acá el daño sería peor. La presencia de `REDIS_URL` elige el
// driver y el presence de Colyseus (ver `src/di-container.ts`): un desarrollador que la tenga
// exportada en su shell —porque corre el truco al lado— haría que los archivos de la suite, que
// corren EN PARALELO, compartan el registro de salas de Colyseus contra un mismo Redis. Cada
// archivo levanta su propio servidor de test, así que se verían las salas unos a otros y un
// `joinById` podría irse a la sala de otro archivo. Eso es exactamente el motivo por el que truco
// necesita un prefijo de claves configurable, y el motivo por el que acá no hace falta.
//
// Es además lo que garantiza que `npm test` no dependa de NINGÚN servicio externo: sin esta
// línea la propiedad no sería del repo sino del entorno de quien lo corre.
delete process.env.REDIS_URL;
// SE BORRA POR LA TERCERA VEZ Y POR LA MISMA RAZÓN. La presencia de `RABBITMQ_URL` es lo que hace
// que el composition root construya un `AmqpPublisher` y arranque el despachador del outbox: un
// desarrollador que la tenga exportada en su shell —porque corre el truco al lado, o el compose de
// otro proyecto— haría que `npm test` abra una conexión de verdad al broker y PUBLIQUE eventos de
// catálogo al exchange `betaso` compartido, desde cuarenta archivos que corren en paralelo.
//
// Y acá el daño sale del repo: los otros dos ensucian una base que es nuestra, éste le manda
// mensajes a los CONSUMIDORES de otro sistema. `amqplib` con `recovery: true` además no rechaza
// cuando el broker no está —cuelga, ver `src/shared/amqp.ts`—, así que el modo de falla del
// olvido no sería un rojo sino una suite que se queda esperando.
delete process.env.RABBITMQ_URL;
process.env.PORT ??= "2567";
process.env.PRESENTING_MATCH_MS ??= "120";
// LOS TRES DE LA REVANCHA, encogidos como los demás. La ventana real es de 30 s: dejarla
// entera haría que CADA e2e que termina una partida espere medio minuto a que la mesa muera.
process.env.REMATCH_WINDOW_MS ??= "1500";
process.env.REMATCH_RESPONSE_MS ??= "1000";
process.env.REMATCH_HANDOFF_MS ??= "1000";
process.env.PRESENTING_ROUND_MS ??= "120";
process.env.TURN_TIMEOUT_MS ??= "600";
process.env.EXTRA_TIME_RESERVE_MS ??= "300";
process.env.DEALING_TIMEOUT_MS ??= "800";
process.env.SEATING_TIMEOUT_MS ??= "3000";
// Tres segundos: el camino de la ventana vencida tiene que poder testearse. Es el plazo
// más largo que queda en test, y sigue siendo mucho más que los 200 ms que tarda el SDK
// en reintentar, así que el camino del bache de red no se lo come.
process.env.RECONNECTION_WINDOW_SECONDS ??= "3";
