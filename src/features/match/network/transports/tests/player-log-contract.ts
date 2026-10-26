import { describe, expect, it } from "vitest";
import type { HistoryPort } from "../../history";
import type { PlayerLog } from "../../player-log";
import type { HistoryAdapterOptions } from "../stored-record";
import { CLOSING, SETUP } from "./history-contract";

// EL HISTORIAL DEL JUGADOR, escrito una vez y corrido contra los dos adaptadores por el criterio de
// `./history-contract.ts`: `MemoryHistory` no es un doble, así que una partida que en memoria aparece y
// en Mongo no es un historial distinto entre dos despliegues del mismo servidor. Lo que sólo Mongo
// puede medir —el plan y su índice— va en `../mongo-history.int.test.ts`.

export type PlayerLogHarness = HistoryPort & PlayerLog;

const T0 = new Date("2026-10-26T12:00:00.000Z").getTime();

// UN RELOJ QUE AVANZA UN SEGUNDO POR ESCRITURA: el orden del historial es el de `createdAt`, y uno de
// verdad podría dar dos partidas en el mismo milisegundo.
function steppingClock() {
  let now = T0;
  return () => {
    now += 1_000;
    return new Date(now);
  };
}

const opening = (roomId: string) => ({ ...SETUP, roomId, matchStartedAt: T0 });

export function describePlayerLogContract(
  name: string,
  create: (options: HistoryAdapterOptions) => PlayerLogHarness | Promise<PlayerLogHarness>,
): void {
  describe(`${name}: el historial del jugador`, () => {
    // TRES PARTIDAS DE u1 —una terminada, una abortada y una en curso— y una de otros dos.
    async function seeded(): Promise<PlayerLogHarness> {
      const log = await create({ now: steppingClock() });
      log.open("m-finished", opening("room-1"));
      log.close("m-finished", CLOSING);
      log.close("m-aborted", {
        ...CLOSING,
        roomId: "room-2",
        status: "aborted",
        matchEndReason: "NEVER_PLAYED",
        winnerIds: [],
      });
      log.open("m-started", opening("room-3"));
      log.open("m-others", {
        ...opening("room-4"),
        seats: SETUP.seats.map((seat, i) => ({ ...seat, userId: `other-${i}` })),
      });
      log.close("m-others", {
        ...CLOSING,
        roomId: "room-4",
        players: CLOSING.players.map((p, i) => ({ ...p, userId: `other-${i}` })),
        seats: SETUP.seats.map((seat, i) => ({ ...seat, userId: `other-${i}` })),
      });
      await log.drain();
      return log;
    }

    it("sólo las suyas y terminadas, la más nueva primero", async () => {
      const page = await (await seeded()).pageOf("u1", 1, 10);

      expect(page.items.map((row) => [row.id, row.result])).toEqual([
        ["m-aborted", "canceled"],
        ["m-finished", "win"],
      ]);
      expect(page).toMatchObject({ page: 1, perPage: 10, totalItems: 2, totalPages: 1 });
    });

    it("cada uno ve la partida desde su asiento", async () => {
      const log = await seeded();
      const [u1] = (await log.pageOf("u1", 1, 10)).items.filter((row) => row.id === "m-finished");
      const [u2] = (await log.pageOf("u2", 1, 10)).items.filter((row) => row.id === "m-finished");

      // LA SALA ES LO QUE EL JUGADOR VE Y DICTA A SOPORTE: viaja aunque la base proyecte la fila.
      expect(u1).toMatchObject({ roomId: "room-1", result: "win", prize: 18, score: 104 });
      expect(u2).toMatchObject({ result: "abandoned", prize: 0, score: 40 });
    });

    it("pagina con la forma de truco", async () => {
      const log = await seeded();

      expect(await log.pageOf("u1", 2, 1)).toMatchObject({
        page: 2,
        perPage: 1,
        totalItems: 2,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
      });
      expect((await log.pageOf("u1", 2, 1)).items.map((row) => row.id)).toEqual(["m-finished"]);
    });

    it("una cuenta que no jugó nada tiene un historial vacío", async () => {
      expect(await (await seeded()).pageOf("nadie", 1, 10)).toMatchObject({
        items: [],
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
      });
    });
  });
}
