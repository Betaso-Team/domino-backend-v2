import { MemoryKeyValueStore } from "@/shared/kv";
import { describe, expect, it } from "vitest";
import { CooldownBook, DEFAULT_COOLDOWN, cooldownLadder } from "./cooldown";

// No shuffling: the tests need to know who got which. The randomness has a test of its own.
const inOrder = <T>(items: readonly T[]): T[] => [...items];

function book(startAt = 1000) {
  const clock = { now: startAt };
  return {
    book: new CooldownBook(
      new MemoryKeyValueStore(() => clock.now),
      DEFAULT_COOLDOWN,
      () => clock.now,
      inOrder,
    ),
    clock,
  };
}

describe("cooldownLadder: el abanico", () => {
  it("con dos jugadores da el corto y el largo", async () => {
    expect(cooldownLadder(2, DEFAULT_COOLDOWN)).toEqual([2_000, 7_000]);
  });

  it("con cuatro reparte en medio, y NINGUNO repite", async () => {
    const delays = cooldownLadder(4, DEFAULT_COOLDOWN);

    expect(delays[0]).toBe(2_000);
    expect(delays[3]).toBe(7_000);
    expect(new Set(delays).size).toBe(4);
  });

  it("con uno solo no hay nada que desincronizar", async () => {
    expect(cooldownLadder(1, DEFAULT_COOLDOWN)).toEqual([2_000]);
    expect(cooldownLadder(0, DEFAULT_COOLDOWN)).toEqual([]);
  });
});

describe("CooldownBook", () => {
  // THE reason it exists, and why the delays DIFFER: if both re-entered at once, each would create
  // their own wait and the veto's escape hatch would have nobody to pair — both passive, nobody
  // searching.
  it("a los que acaban de jugar les toca esperar distinto", async () => {
    const { book: cooldown } = book();

    await cooldown.assign("mesa", ["u1", "u2"]);

    expect(await cooldown.consume("mesa", "u1")).toBe(2_000);
    expect(await cooldown.consume("mesa", "u2")).toBe(7_000);
  });

  it("es de un solo uso: consumir lo borra", async () => {
    const { book: cooldown } = book();
    await cooldown.assign("mesa", ["u1", "u2"]);

    await cooldown.consume("mesa", "u1");

    expect(await cooldown.consume("mesa", "u1")).toBe(0);
  });

  // Whoever takes a while to return does not wait twice: they already waited outside.
  it("descuenta el tiempo transcurrido desde que se asignó", async () => {
    const { book: cooldown, clock } = book();
    await cooldown.assign("mesa", ["u1", "u2"]);

    clock.now += 5_000;

    expect(await cooldown.consume("mesa", "u2")).toBe(2_000); // le tocaban 7s y ya pasaron 5
    expect(await cooldown.consume("mesa", "u1")).toBe(0); // le tocaban 2s: hace rato que puede
  });

  it("el que no vuelve nunca se olvida solo", async () => {
    const { book: cooldown, clock } = book();
    await cooldown.assign("mesa", ["u1", "u2"]);

    clock.now += DEFAULT_COOLDOWN.ttlMs;

    expect(await cooldown.consume("mesa", "u2")).toBe(0);
  });

  // The scope isolates contexts: one table's delay has no business holding up entry to another.
  it("el retraso es del ámbito donde jugaron", async () => {
    const { book: cooldown } = book();

    await cooldown.assign("mesa-a", ["u1", "u2"]);

    expect(await cooldown.consume("mesa-b", "u1")).toBe(0);
  });

  it("sin al menos dos jugadores no hay nada que desincronizar", async () => {
    const { book: cooldown } = book();

    await cooldown.assign("mesa", ["u1"]);

    expect(await cooldown.consume("mesa", "u1")).toBe(0);
  });

  // Who gets the short one is random. Without this one player would be systematically favoured — the
  // first of the list always re-enters sooner — and over time that shows.
  it("a quién le toca el corto se decide al azar", async () => {
    const clock = { now: 1000 };
    const reversed = new CooldownBook(
      new MemoryKeyValueStore(() => clock.now),
      DEFAULT_COOLDOWN,
      () => clock.now,
      (items) => [...items].reverse(),
    );

    await reversed.assign("mesa", ["u1", "u2"]);

    expect(await reversed.consume("mesa", "u2")).toBe(2_000);
    expect(await reversed.consume("mesa", "u1")).toBe(7_000);
  });
});
