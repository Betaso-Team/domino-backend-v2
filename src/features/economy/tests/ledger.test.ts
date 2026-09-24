import { MemoryLedger } from "@/features/economy";
import { describe, expect, it } from "vitest";
import { DuplicateMovementError } from "../ledger";
import type { Movement } from "../wallet";

const entry: Movement = { matchId: "m1", playerId: "u1", amount: 10, reason: "ENTRY_FEE" };

describe("Ledger: la clave que impide el doble cobro", () => {
  it("reservar dos veces la misma tupla no se puede", async () => {
    const ledger = new MemoryLedger();
    await ledger.reserve(entry);

    await expect(ledger.reserve(entry)).rejects.toBeInstanceOf(DuplicateMovementError);
  });

  it("la RAZÓN es parte de la clave: cobrar el multiplicador no choca con la entrada", async () => {
    const ledger = new MemoryLedger();
    await ledger.reserve(entry);

    expect(() => ledger.reserve({ ...entry, reason: "BET_MULTIPLIER" })).not.toThrow();
  });

  it("la PARTIDA es parte de la clave: el mismo jugador paga entrada en cada una", async () => {
    const ledger = new MemoryLedger();
    await ledger.reserve(entry);

    expect(() => ledger.reserve({ ...entry, matchId: "m2" })).not.toThrow();
  });

  it("reserva PENDIENTE, y se liquida al confirmarse", async () => {
    const ledger = new MemoryLedger();

    expect((await ledger.reserve(entry)).status).toBe("PENDING");
    await ledger.settle(entry);

    expect((await ledger.entriesOf("m1"))[0]?.status).toBe("SETTLED");
  });

  it("un movimiento fallido queda FAILED, no desaparece: es lo que deja reconciliar", async () => {
    const ledger = new MemoryLedger();
    await ledger.reserve(entry);

    await ledger.fail(entry);

    expect(await ledger.entriesOf("m1")).toHaveLength(1);
    expect((await ledger.entriesOf("m1"))[0]?.status).toBe("FAILED");
  });
});
