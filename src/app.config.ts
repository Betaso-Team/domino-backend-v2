import config from "@colyseus/tools";
import { defineRoom, defineServer } from "colyseus";
import type { Application } from "express";
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

const rooms = { domino: defineRoom(DominoRoom) };

// EL COMPOSITION ROOT de la superficie Express. Acá —y solo acá— se resuelve del container
// y se lee `env`: el transporte recibe las cinco dependencias ya armadas y no sabe que
// ninguna de las dos cosas existe (Regla 3). Es el mismo lugar que `src/index.ts` ocupa en
// truco; en domino el `app.config` es el que arma las dos superficies, la de test y la real.
const registerHttp = (app: Application) =>
  registerMatchHttp(app, {
    registry: rootContainer.resolve(MatchRegistry),
    clock: rootContainer.resolve<Clock>("Clock"),
    logger: rootContainer.resolve<Logger>("Logger"),
    history: rootContainer.resolve<HistoryReader>("HistoryReader"),
    internalApiKey: env.internalApiKey,
  });

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
