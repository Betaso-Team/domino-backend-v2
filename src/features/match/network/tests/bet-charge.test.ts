import { MemoryLedger } from "@/features/economy";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it, vi } from "vitest";
import { BetCharger } from "../bet-charge";
import type { NetworkMatchEvent } from "../events";

// EL COBRO DEL AUMENTO, que es el único camino del repo donde una partida mueve dinero SIN que
// termine. Lo que se mide son las tres partes del «si no se puede», porque cada una tapa una
// forma distinta de que alguien quede sin su plata:
//
//   · en serie  → no se le cobra a un tercero cuando ya se sabe que no se va a poder honrar
//   · con plazo → una billetera muda no deja el trato en el limbo
//   · al fallar → se devuelve lo cobrado Y se anula el trato

const AGREED = {
  type: "MULTIPLIER_AGREED",
  level: 5,
  extra: 5,
  additionalEntryFee: 500,
  playerIds: ["seat-1", "seat-2"],
} as const;

const REVOKED: readonly NetworkMatchEvent[] = [{ type: "MULTIPLIER_REVOKED", level: 5 }];

const build = (
  over: { charge?: (playerId: string) => Promise<void>; refund?: () => Promise<void> } = {},
) => {
  const charged: string[] = [];
  const refunded: string[] = [];
  const emitted: NetworkMatchEvent[] = [];
  const log = new MemoryLogger();
  const ledger = new MemoryLedger();
  const revoke = vi.fn(() => REVOKED);
  const charger = new BetCharger({
    wallet: {
      charge: async (movement) => {
        charged.push(movement.playerId);
        if (over.charge) await over.charge(movement.playerId);
      },
      refund: async (movement) => {
        refunded.push(movement.playerId);
        if (over.refund) await over.refund();
      },
    },
    ledger,
    timeoutMs: 50,
    log,
  });
  const sink = charger.sinkFor("match-1", (events) => emitted.push(...events), revoke);
  return { sink, charged, refunded, emitted, revoke, log, ledger };
};

// El sink es síncrono a propósito —el motor lo es—, así que lo único que hace es arrancar el
// trabajo. Esto lo deja terminar.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("el cobro del aumento", () => {
  it("les cobra a los dos la diferencia", async () => {
    const built = build();

    built.sink([AGREED]);
    await settle();

    expect(built.charged).toEqual(["seat-1", "seat-2"]);
    expect(built.refunded).toEqual([]);
    expect(built.emitted).toEqual([]);
    expect(built.revoke).not.toHaveBeenCalled();
  });

  // ⚠ EN SERIE Y NO EN PARALELO. Con el segundo sin saldo, al PRIMERO ya se le cobró y hay que
  // devolverle; si además se le hubiera cobrado a un tercero en paralelo, serían dos devoluciones
  // por un trato que ya se sabía muerto. Con dos jugadores el orden se ve igual: el segundo falla
  // y el primero se devuelve.
  it("si el segundo no puede pagar, le devuelve al primero y anula el trato", async () => {
    const built = build({
      charge: async (playerId) => {
        if (playerId === "seat-2") throw new Error("sin saldo");
      },
    });

    built.sink([AGREED]);
    await settle();

    expect(built.charged).toEqual(["seat-1", "seat-2"]);
    expect(built.refunded).toEqual(["seat-1"]);
    expect(built.emitted).toEqual(REVOKED);
  });

  // EL PRIMERO QUE FALLA NO DEJA NADA QUE DEVOLVER, pero el trato se anula igual: el estado dice
  // x5 desde que el motor lo asentó, y nadie lo pagó.
  it("si falla el primero, no devuelve nada y anula igual", async () => {
    const built = build({ charge: async () => Promise.reject(new Error("sin saldo")) });

    built.sink([AGREED]);
    await settle();

    expect(built.refunded).toEqual([]);
    expect(built.emitted).toEqual(REVOKED);
  });

  // UNA BILLETERA MUDA NO PUEDE DEJAR EL TRATO EN EL LIMBO. Sin el plazo, la mesa se queda
  // diciendo x5 para siempre mientras nadie pagó — que es peor que cobrar mal, porque no hay
  // nada que reconciliar después.
  it("una billetera que no contesta cuenta como que no se pudo", async () => {
    const built = build({ charge: () => new Promise<void>(() => {}) });

    built.sink([AGREED]);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(built.emitted).toEqual(REVOKED);
  });

  // ⚠ LA ANULACIÓN VA SIEMPRE, hayan salido o no las devoluciones: el trato no quedó respaldado,
  // y eso es cierto con independencia de cómo le fue al reembolso. Y el fallo del reembolso queda
  // ASENTADO — deshacer un cobro pide reconciliación, y reconciliar pide que el registro exista.
  it("un reembolso que falla se anota y no impide anular el trato", async () => {
    const built = build({
      charge: async (playerId) => {
        if (playerId === "seat-2") throw new Error("sin saldo");
      },
      refund: () => Promise.reject(new Error("la billetera no contesta")),
    });

    built.sink([AGREED]);
    await settle();

    expect(built.emitted).toEqual(REVOKED);
    expect(built.log.at_("error").map((line) => line.msg)).toContain(
      "no se pudo devolver el aumento cobrado",
    );
  });

  // NADIE PAGA DOS VECES. El libro mayor es quien lo garantiza: un movimiento ya asentado cuenta
  // como pagado, así que un segundo anuncio del mismo trato no vuelve a tocar la billetera.
  it("el mismo trato anunciado dos veces no cobra dos veces", async () => {
    const built = build();

    built.sink([AGREED]);
    await settle();
    built.sink([AGREED]);
    await settle();

    expect(built.charged).toEqual(["seat-1", "seat-2"]);
  });

  // UNA MESA QUE NO COBRA NO SE COBRA. Es la segunda cerradura y no la primera —una mesa gratis no
  // debería tener niveles—, pero es la que impide un movimiento de cero contra la billetera.
  it("no toca la billetera si el aumento no cuesta nada", async () => {
    const built = build();

    built.sink([{ ...AGREED, additionalEntryFee: 0 }]);
    await settle();

    expect(built.charged).toEqual([]);
  });

  it("ignora todo lo que no sea un trato cerrado", async () => {
    const built = build();

    built.sink([
      { type: "MULTIPLIER_REVOKED", level: 5 },
      { type: "BET_MULTIPLIER_REJECTED", playerId: "seat-2" },
    ]);
    await settle();

    expect(built.charged).toEqual([]);
  });
});
