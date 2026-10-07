import { ErrorCode, ServerError, generateId, matchMaker } from "@colyseus/core";
import type { CreateMatchRequest, MatchParticipant } from "../match-contract";

/** La mesa que abrió el orquestador: su sala y una reserva por participante. */
export interface OpenedTable {
  readonly roomId: string;
  readonly seats: readonly { readonly userId: string; readonly reservation: unknown }[];
}

export class ColyseusMatchGateway {
  // LA MESA QUE PIDE EL ORQUESTADOR, que es la única forma de abrir una: el request crudo, validado
  // por la sala (`requestOf`). La sala no cobra, no reembolsa y no paga: el dinero de la mesa lo
  // mueve el orquestador, nunca el juego.
  async openRequest(request: CreateMatchRequest): Promise<OpenedTable> {
    const { roomId, reservations } = await this.create(request);
    return {
      roomId,
      seats: reservations.map((reservation, index) => ({
        userId: (request.participants[index] as MatchParticipant).userId,
        reservation,
      })),
    };
  }

  // `undefined` SOLO si la sala ya no existe: el índice de `matchOf` puede sobrevivirla hasta su plazo.
  // `joinById` tira el MISMO código (MATCHMAKE_INVALID_ROOM_ID) para una sala ausente y para una
  // BLOQUEADA, y una bloqueada es de alguien que sigue sentado: cada vuelta sin consumir es una
  // reserva que cuenta contra `maxClients`, así que unas pocas bastan para bloquear una mesa de 2.
  // Contestar 404 ahí diría "no está en ninguna mesa" y el orquestador le abriría una segunda; por
  // eso se pregunta si la sala existe y, si existe, el error se relanza (500 ⇒ desconocido).
  // `joinById` pasa solo por el `onAuth` ESTÁTICO de paso; el token se verifica cuando el jugador
  // conecta el socket con esta reserva.
  async seatBack(roomId: string): Promise<unknown | undefined> {
    try {
      return await matchMaker.joinById(roomId, {});
    } catch (error) {
      if (error instanceof ServerError && error.code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID) {
        const alive = await matchMaker.query({ roomId });
        if (alive.length === 0) return undefined;
      }
      throw error;
    }
  }

  private async create(request: CreateMatchRequest) {
    const room = await matchMaker.createRoom("domino", request);
    const sessionIds = Array.from({ length: request.participants.length }, () => generateId());
    const reserved = await matchMaker.reserveMultipleSeatsFor(
      room,
      sessionIds.map((sessionId) => ({ sessionId, options: {}, auth: undefined })),
    );
    if (reserved.some((ok) => !ok)) {
      throw new Error(`no se pudieron reservar todos los asientos de ${room.roomId}`);
    }
    return {
      roomId: room.roomId,
      reservations: sessionIds.map((sessionId) => matchMaker.buildSeatReservation(room, sessionId)),
    };
  }
}
