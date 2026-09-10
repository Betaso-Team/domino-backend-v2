import "reflect-metadata";

// src/env.ts valida el entorno al importarse y lanza si falta JWT_SECRET (ver su cabecera).
// Estos defaults evitan que cualquier test que importe env.ts — directa o transitivamente —
// explote solo por correr sin variables configuradas.
process.env.NODE_ENV ??= "test";
process.env.JWT_SECRET ??= "test-secret-do-not-use-in-production";
process.env.PORT ??= "2567";
