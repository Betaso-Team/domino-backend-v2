import { withTimeout } from "@/shared/deadline";
import { generateId, matchMaker } from "@colyseus/core";
import type { CreateMatchRequest, MatchParticipant } from "../match-contract";

// CUÁNTO SE ESPERA A QUE EL MATCHMAKER DIGA SI UNA SALA EXISTE, como truco (`53d1030`). Es una lectura
// del registro de salas (`roomcaches` en Redis): si tarda más que esto, algo anda mal y la respuesta es
// «no sé», que nunca es «no existe».
export const ROOM_QUERY_TIMEOUT_MS = 2_000;

/** Lo que la vuelta al asiento le pide al matchmaker. Por parámetro para poder medirlo sin Colyseus. */
export interface SeatBackMatchMaker {
  joinById(roomId: string, options: object): Promise<unknown>;
  query(conditions: { roomId: string }): Promise<readonly unknown[]>;
}

/** La mesa que abrió el orquestador: su sala y una reserva por participante. */
export interface OpenedTable {
  readonly roomId: string;
  readonly seats: readonly { readonly userId: string; readonly reservation: unknown }[];
}

export class ColyseusMatchGateway {
  constructor(
    private readonly rooms: SeatBackMatchMaker = matchMaker,
    private readonly queryTimeoutMs: number = ROOM_QUERY_TIMEOUT_MS,
  ) {}

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
  //
  // CUALQUIER FALLO DE LA RESERVA SE CONFIRMA CONTRA EL MATCHMAKER, no solo `MATCHMAKE_INVALID_ROOM_ID`
  // (truco `53d1030`, T-04). Con más de una instancia, la sala de un proceso que murió de golpe sigue
  // anunciada, y `joinById` no dice «no existe»: le pide el asiento al dueño, no contesta, Colyseus le
  // hace el chequeo de salud, lo excluye, borra sus salas y tira `SeatReservationError`. Antes eso era
  // un 500, el orquestador contestaba `TABLE_UNAVAILABLE` y el jugador quedaba trabado hasta que
  // vencía su entrada del registro. Ahora, si después del fallo la sala ya no figura, es «sin partida».
  //
  // Si sigue figurando —o la pregunta no se pudo contestar— se relanza el error original (500):
  // contestar 404 por una sala viva diría "no está en ninguna mesa" y el orquestador le abriría una
  // segunda. La sala ya no tiene `maxClients`, así que no se bloquea nunca y un jugador todavía
  // conectado desde otro lado recibe el asiento igual —consumirlo desplaza la otra conexión—.
  // `joinById` pasa solo por el `onAuth` ESTÁTICO de paso; el token se verifica cuando el jugador
  // conecta el socket con esta reserva.
  async seatBack(roomId: string): Promise<unknown | undefined> {
    try {
      return await this.rooms.joinById(roomId, {});
    } catch (error) {
      if (await this.isGone(roomId)) return undefined;
      throw error;
    }
  }

  // `true` SOLO SI EL MATCHMAKER CONFIRMA QUE LA SALA NO ESTÁ. Una pregunta que falla o que no contesta
  // a tiempo es «no sé», y «no sé» se trata como viva: el error caro es abrirle una segunda mesa a quien
  // todavía tiene una, no hacerlo esperar.
  //
  // ⚠ Lo que mira es el registro de salas, no al dueño: la sala de un proceso muerto sigue figurando
  // hasta que alguien le hace el chequeo de salud (una reserva que falla, el barrido de
  // `stale-rooms.ts` al arrancar otra instancia).
  async isGone(roomId: string): Promise<boolean> {
    const listed = await withTimeout(this.rooms.query({ roomId }), this.queryTimeoutMs).catch(
      () => undefined,
    );
    return listed?.length === 0;
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
