import config from "@colyseus/tools";
import { defineRoom, defineServer } from "colyseus";
import express, { type Application } from "express";
import { rootContainer } from "./di-container.js";
import { env } from "./env.js";
import {
  type Clock,
  DominoRoom,
  type HistoryReader,
  MatchRegistry,
  registerMatchHttp,
} from "./features/match/index.js";
import type { Logger } from "./logger.js";
import { httpErrorHandler } from "./shared/http/error-handler.js";

const rooms = { domino: defineRoom(DominoRoom) };

// EL COMPOSITION ROOT de la superficie Express. Acá —y solo acá— se resuelve del container
// y se lee `env`: el transporte recibe las cinco dependencias ya armadas y no sabe que
// ninguna de las dos cosas existe (Regla 3). Es el mismo lugar que `src/index.ts` ocupa en
// truco; en domino el `app.config` es el que arma las dos superficies, la de test y la real.
//
// EL ORDEN DE LAS TRES LÍNEAS ES EL CONTRATO, y no es estilo:
//   1. `express.json()` primero, o las rutas leen un `req.body` que nadie parseó;
//   2. las rutas;
//   3. el manejador de errores ÚLTIMO. Express lo reconoce por la ARIDAD de cuatro
//      parámetros y solo alcanza lo que se registró ANTES que él.
//
// El `express()` de abajo no es nuestro: lo construye `WebSocketTransport.getExpressApp()`
// PELADO —sin parser de cuerpo y sin manejador de errores—, así que hoy una ruta que tira
// devuelve la página HTML por defecto de Express con el stack adentro (el default de
// `NODE_ENV` en `src/env.ts` es `development`).
//
// `express.json()` NO le come el cuerpo al `POST /matchmake/*` del SDK: en 0.18 el
// matchmaking ni siquiera pasa por Express. `bindRouterToTransport` antepone un listener de
// `request` en el servidor HTTP y, si la URL es del router de Colyseus, la resuelve contra
// el `req` crudo; solo delega en `expressApp.handle()` cuando NO lo es. Verificado además
// contra el servidor levantado: el mismo `POST /matchmake/*` responde idéntico con y sin
// estas líneas, y los e2e —que se reconectan por `joinById`, o sea por HTTP— siguen verdes.
//
// Y LA RAÍZ `/` TAMBIÉN ES DE ACÁ el día que alguien la registre, aunque Colyseus tenga un
// banner propio en esa misma ruta. Medido, no deducido: `Server.listen()` hace
// `await this._bootForListen()` —el que llama a esta función (`Server.mjs:257`)— ANTES de
// `bindRoutes()` (`Server.mjs:68` y `:93`), así que cuando `bindRouterToTransport` pregunta
// si ya hay una raíz (`router/index.mjs:21-28`) las rutas de acá YA están en el stack de
// Express y el `Colyseus x.y.z` no llega a registrarse. Sin endpoint `/` en su router, el
// `findRoute` del listener antepuesto no matchea y la request cae en `expressApp.handle()`
// (`router/index.mjs:39` y `:45`).
//
// Ese chequeo vive en una dependencia y un bump de versión puede invertir el orden sin
// avisar, dejando una raíz nuestra ignorada sin un solo error. Lo pinea
// `src/http-root-route.test.ts`, que levanta el servidor con un `GET /` puesto y lo pide.
const registerHttp = (app: Application) => {
  const logger = rootContainer.resolve<Logger>("Logger");
  app.use(express.json());
  registerMatchHttp(app, {
    registry: rootContainer.resolve(MatchRegistry),
    clock: rootContainer.resolve<Clock>("Clock"),
    logger,
    history: rootContainer.resolve<HistoryReader>("HistoryReader"),
    internalApiKey: env.internalApiKey,
  });
  app.use(httpErrorHandler(logger));
};

// @colyseus/testing solo respeta el puerto pedido cuando recibe opciones, no un
// Server ya construido. Ambas superficies comparten estas mismas definiciones.
export const testConfig = config({
  rooms,
  initializeExpress: registerHttp,
});

// El export nombrado conserva el tipo de salas para el cliente generado de Colyseus.
export const server = defineServer({
  rooms,
  express: registerHttp,
});

export default server;
