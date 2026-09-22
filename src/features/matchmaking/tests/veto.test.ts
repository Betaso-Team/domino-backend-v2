import { MemoryKeyValueStore } from "@/shared/kv";
import { describe, expect, it } from "vitest";
import {
  CASUAL_SCOPE,
  VetoBook,
  type VetoConfig,
  type VetoKey,
  casualVetoKey,
  tournamentVetoKey,
} from "../veto";

// What tells the two scopes apart is the TTL and the SHAPE OF THE KEY, so each is tested with its
// own: the casual one has no scope, being global per account, and the tournament one carries it
// inside.
const CFG: VetoConfig = { ttlMs: 6 * 60 * 60 * 1000 };

// The scope does not travel in the key: it travels in WHICH BOOK is used. It is v1's shape, and
// sharing it is what makes a veto set by one engine visible to the other.
function book(key: VetoKey = casualVetoKey, startAt = 1000) {
  const clock = { now: startAt };
  const kv = new MemoryKeyValueStore(() => clock.now);
  return { book: new VetoBook(kv, key, CFG), kv, clock };
}

describe("Veto de pareja: no volver a cruzar a los mismos, por un rato", () => {
  it("es bidireccional: da igual en qué orden se pregunte", async () => {
    const { book: veto } = book();

    await veto.register("t1", ["u1", "u2"]);

    expect(await veto.isVetoed("t1", "u1", "u2")).toBe(true);
    expect(await veto.isVetoed("t1", "u2", "u1")).toBe(true);
  });

  it("caduca: es una preferencia temporal, no un castigo", async () => {
    const { book: veto, clock } = book();
    await veto.register("t1", ["u1", "u2"]);

    clock.now += CFG.ttlMs;

    expect(await veto.isVetoed("t1", "u1", "u2")).toBe(false);
  });

  it("registrar dos veces solo renueva el plazo", async () => {
    const { book: veto, clock } = book();
    await veto.register("t1", ["u1", "u2"]);

    clock.now += CFG.ttlMs - 1;
    await veto.register("t1", ["u1", "u2"]);
    clock.now += CFG.ttlMs - 1;

    expect(await veto.isVetoed("t1", "u1", "u2")).toBe(true);
  });

  it("el de TORNEO es por torneo: vetarse en uno no veta en otro", async () => {
    const { book: veto } = book(tournamentVetoKey);

    await veto.register("t1", ["u1", "u2"]);

    expect(await veto.isVetoed("t1", "u1", "u2")).toBe(true);
    expect(await veto.isVetoed("t2", "u1", "u2")).toBe(false);
  });

  it("en 2v2 veta las seis parejas: se cruzaron CUENTAS, no equipos", async () => {
    const { book: veto } = book();

    await veto.register("t1", ["u1", "u2", "u3", "u4"]);

    // Partners are included among themselves: two accomplices can play on the same side.
    expect(await veto.isVetoed("t1", "u1", "u3")).toBe(true); // rivales
    expect(await veto.isVetoed("t1", "u1", "u2")).toBe(true); // compañeros
    expect([...(await veto.vetoedFor("t1", "u1"))].sort()).toEqual(["u2", "u3", "u4"]);
  });

  it("lista con quiénes preferiría no cruzarse, para que el emparejamiento los evite", async () => {
    const { book: veto } = book();
    await veto.register("t1", ["u1", "u2"]);

    expect(await veto.vetoedFor("t1", "u1")).toEqual(["u2"]);
    expect(await veto.vetoedFor("t1", "u3")).toEqual([]);
  });

  // BOTH scopes in one book, which is why the axis is called a scope. The casual one is global per
  // account — being vetoed at one table vetoes at all of them, because otherwise two accomplices
  // change table and the veto does not exist — and the tournament one lives inside its tournament.
  it("el casual es global por cuenta: el ámbito no cambia nada", async () => {
    const { book: veto } = book();

    await veto.register("mesa-a", ["u1", "u2"]);

    expect(await veto.vetoedFor("mesa-b", "u1")).toEqual(["u2"]);
  });

  // And the two books do not overlap despite sharing a Redis: their keys start differently.
  it("el casual y el de torneo no se mezclan", async () => {
    const { kv, book: casual } = book();
    const tournament = new VetoBook(kv, tournamentVetoKey, CFG);

    await casual.register(CASUAL_SCOPE, ["u1", "u2"]);
    await tournament.register("t1", ["u3", "u4"]);

    expect(await tournament.vetoedFor("t1", "u1")).toEqual([]);
    expect(await casual.vetoedFor(CASUAL_SCOPE, "u3")).toEqual([]);
  });
});
