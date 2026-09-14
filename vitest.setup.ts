import "reflect-metadata";

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
process.env.PORT ??= "2567";
process.env.PRESENTING_MATCH_MS ??= "120";
process.env.PRESENTING_ROUND_MS ??= "120";
process.env.TURN_TIMEOUT_MS ??= "600";
process.env.EXTRA_TIME_RESERVE_MS ??= "300";
process.env.DEALING_TIMEOUT_MS ??= "800";
process.env.SEATING_TIMEOUT_MS ??= "3000";
// Tres segundos: el camino de la ventana vencida tiene que poder testearse. Es el plazo
// más largo que queda en test, y sigue siendo mucho más que los 200 ms que tarda el SDK
// en reintentar, así que el camino del bache de red no se lo come.
process.env.RECONNECTION_WINDOW_SECONDS ??= "3";
