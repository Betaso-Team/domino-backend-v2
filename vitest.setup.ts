import "reflect-metadata";

// src/env.ts valida el entorno al importarse y lanza si falta JWT_SECRET (ver su cabecera).
// Estos defaults evitan que cualquier test que importe env.ts — directa o transitivamente —
// explote solo por correr sin variables configuradas.
process.env.NODE_ENV ??= "test";
process.env.JWT_SECRET ??= "test-secret-do-not-use-in-production";
// Sin esto la API interna no se registra (fail closed) y sus tests e2e no tendrían
// ruta contra la cual medir. El caso "sin llave" se prueba aparte, sin servidor.
process.env.INTERNAL_API_KEY ??= "test-internal-key-do-not-use-in-production";
process.env.PORT ??= "2567";
process.env.PRESENTING_MATCH_MS ??= "120";
process.env.PRESENTING_ROUND_MS ??= "120";
process.env.TURN_TIMEOUT_MS ??= "600";
process.env.EXTRA_TIME_RESERVE_MS ??= "300";
process.env.SEATING_TIMEOUT_MS ??= "3000";
