// EL ÚNICO LUGAR DE LA SUITE QUE LEE UN SERVICIO EXTERNO DEL ENTORNO, y existe para que sea uno
// solo.
//
// `vitest.setup.ts` BORRA `MONGO_URI`, `REDIS_URL` y `RABBITMQ_URL` a propósito: que la suite no
// dependa de ningún servicio es una propiedad del repo y no del shell de quien la corre, y de paso
// la presencia de esas tres variables es lo que ELIGE la implementación de cada puerto. Un test de
// contrato contra una base de verdad no puede leerlas, entonces: se saltearía siempre, que es peor
// que no existir —un test que nunca puede correr se lee como cobertura en el reporte—.
//
// Con un nombre propio, el que tiene una base la corre y el que no la ve SALTEADA, con el nombre
// que dice cómo correrla:
//
//     MONGO_INT_URI=mongodb://127.0.0.1:27017/domino_int npm run test:int
//
// Está en `EXCLUDED_PATHS` de `src/env-single-reader.test.ts`, y la exclusión se sostiene porque
// esto NO es configuración del proceso: la app no lo lee ni lo conoce, y no hay dos lugares que
// puedan discrepar sobre su valor. Concentrarlo acá es lo que mantiene esa exclusión en UN archivo
// en vez de una por test de integración.
export const MONGO_INT_URI = process.env.MONGO_INT_URI;
