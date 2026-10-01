import { defineRoom } from "colyseus";
import { DominoRoom } from "./domino-room";

// LAS SALAS DE LA FEATURE, como su pedazo del mapa de salas del servidor: la misma forma que su
// transporte HTTP (truco `597e5af`).
//
// ⚠ NO SALE POR `features/match/index.ts`, y es un ciclo lo que lo impide: `DominoRoom` resuelve del
// container (es composition root, Regla 3) y el container importa ese índice. Por eso
// `app.config.ts` importa este archivo en profundidad, igual que antes importaba la sala.
export function matchRooms() {
  return { domino: defineRoom(DominoRoom) };
}
