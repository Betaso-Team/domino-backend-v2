import { generateId, matchMaker } from "@colyseus/core";
import type { DominoRoomOptions, MatchOpener, Seat } from "../match-contract";

export class ColyseusMatchGateway implements MatchOpener {
  async open(options: DominoRoomOptions): Promise<readonly Seat[]> {
    const room = await matchMaker.createRoom("domino", options);
    const sessionIds = options.seats.map(() => generateId());
    const reserved = await matchMaker.reserveMultipleSeatsFor(
      room,
      sessionIds.map((sessionId) => ({ sessionId, options: {}, auth: undefined })),
    );
    if (reserved.some((ok) => !ok)) {
      throw new Error(`no se pudieron reservar todos los asientos de ${room.roomId}`);
    }
    return sessionIds.map((sessionId, index) => ({
      playerId: options.seats[index] as string,
      reservation: matchMaker.buildSeatReservation(room, sessionId),
    }));
  }

  async rejoin(roomId: string, playerId: string): Promise<Seat> {
    return { playerId, reservation: await matchMaker.joinById(roomId, {}) };
  }
}
