import { defineRoom, defineServer } from "colyseus";
import { DominoRoom, registerMatchHttp } from "./features/match/index.js";

// El export nombrado conserva el tipo de salas para el cliente generado de Colyseus.
export const server = defineServer({
  rooms: { domino: defineRoom(DominoRoom) },
  express: (app) => registerMatchHttp(app),
});

export default server;
