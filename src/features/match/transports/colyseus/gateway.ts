import { ErrorCode, ServerError, generateId, matchMaker } from "@colyseus/core";
import type {
  CreateMatchRequest,
  DominoRoomOptions,
  MatchOpener,
  MatchParticipant,
  Seat,
} from "../match-contract";

/** La mesa que abrió el orquestador: su sala y una reserva por participante. */
export interface OpenedTable {
  readonly roomId: string;
  readonly seats: readonly { readonly userId: string; readonly reservation: unknown }[];
}

export class ColyseusMatchGateway implements MatchOpener {
  async open(options: DominoRoomOptions): Promise<readonly Seat[]> {
    const { reservations } = await this.create(options, options.seats.length);
    return reservations.map((reservation, index) => ({
      playerId: options.seats[index] as string,
      reservation,
    }));
  }

  // LA MESA QUE PIDE EL ORQUESTADOR: el request crudo, sin `roomOptions`, así que la sala nace
  // sin plataforma —no cobra, no reembolsa, no paga— (ver `DominoRoom.onCreate`). El dinero de
  // esa mesa lo mueve el orquestador, nunca el juego.
  async openRequest(request: CreateMatchRequest): Promise<OpenedTable> {
    const { roomId, reservations } = await this.create(request, request.participants.length);
    return {
      roomId,
      seats: reservations.map((reservation, index) => ({
        userId: (request.participants[index] as MatchParticipant).userId,
        reservation,
      })),
    };
  }

  async rejoin(roomId: string, playerId: string): Promise<Seat> {
    return { playerId, reservation: await matchMaker.joinById(roomId, {}) };
  }

  // `undefined` si la sala ya no está: el índice de `matchOf` puede sobrevivirla hasta su plazo.
  // `joinById` pasa solo por el `onAuth` ESTÁTICO de paso; el token se verifica cuando el jugador
  // conecta el socket con esta reserva.
  async seatBack(roomId: string): Promise<unknown | undefined> {
    try {
      return await matchMaker.joinById(roomId, {});
    } catch (error) {
      if (error instanceof ServerError && error.code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID)
        return undefined;
      throw error;
    }
  }

  private async create(options: DominoRoomOptions | CreateMatchRequest, seats: number) {
    const room = await matchMaker.createRoom("domino", options);
    const sessionIds = Array.from({ length: seats }, () => generateId());
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
