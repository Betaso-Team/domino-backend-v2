import { matchMaker } from "colyseus";

// LAS SALAS DE UN PROCESO QUE YA NO EXISTE. Colyseus las borra del almacén compartido al FINAL de su
// apagado (`gracefullyShutdown`: primero se saca de `roomcount`, después espera que cierren las salas,
// recién ahí `driver.cleanup`). Un proceso que muere en el medio —`kill -9`, OOM, el `kill_timeout`
// de pm2— deja sus salas en `roomcaches` con un dueño que ya no está en `roomcount`, y el chequeo de
// salud del arranque (`healthCheckAllProcesses`) solo recorre `roomcount`: no las ve NUNCA.
//
// Pasó en producción con el dominó v1 (2026-10-20): un lobby huérfano en Redis, todo
// `joinOrCreate` iba a pedirle asiento a un proceso muerto y colgaba sin un error, con pm2 y
// `/health` en verde. Acá la reconexión se cura sola al tocar la sala (la reserva vence y Colyseus
// chequea al dueño), pero mientras nadie la toque la sala sigue anunciada.
//
// El arreglo es el mismo chequeo de Colyseus (`healthCheckProcessId`: si no contesta, lo excluye y
// borra sus salas) aplicado a los dueños que aparecen en las SALAS y no en las estadísticas.

export interface StaleRoomsMatchMaker {
  readonly processId: string;
  readonly driver: {
    query(
      conditions: object,
    ): readonly { processId: string }[] | Promise<readonly { processId: string }[]>;
  };
  healthCheckProcessId(processId: string): Promise<unknown>;
}

/** @returns los procesos ajenos que se chequearon. */
export async function sweepStaleRooms(matchMaker: StaleRoomsMatchMaker): Promise<string[]> {
  const rooms = await matchMaker.driver.query({});
  const owners = [...new Set(rooms.map((room) => room.processId))]
    .filter((id) => id !== matchMaker.processId)
    .sort();
  await Promise.all(owners.map((id) => matchMaker.healthCheckProcessId(id)));
  return owners;
}

/** El barrido contra el `matchMaker` de verdad. Lo llama `src/main.ts` con el servidor ya escuchando. */
export const sweepStaleRoomsNow = (): Promise<string[]> => sweepStaleRooms(matchMaker);
