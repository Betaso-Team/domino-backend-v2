import config from "@colyseus/tools";
import { defineRoom, defineServer } from "colyseus";
import type { Application } from "express";
import { DominoRoom, registerMatchHttp } from "./features/match/index.js";

const rooms = { domino: defineRoom(DominoRoom) };
const registerHttp = (app: Application) => registerMatchHttp(app);

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
