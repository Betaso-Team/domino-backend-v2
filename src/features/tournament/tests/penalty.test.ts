import { MemoryKeyValueStore } from "@/shared/kv";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOURNAMENT_CONFIG as CFG } from "../config";
import { StrikeBook, penaltyMinutesFor } from "../penalty";

const MINUTE = 60_000;

function book(startAt = 1000) {
  const clock = { now: startAt };
  return {
    book: new StrikeBook(new MemoryKeyValueStore(() => clock.now), CFG, () => clock.now),
    clock,
  };
}

describe("Strikes: abandonar cuesta, y cuesta más cada vez", () => {
  // The penalty starts on the SECOND walkout, which is what the platform applies today.
  it.each([
    [1, 0, "el primero solo queda registrado"],
    [2, 10, "el segundo ya penaliza"],
    [3, 20, "y escala"],
    [5, 40, "N-ésimo = 10 × (N−1)"],
  ])("%s abandono(s) → %s min (%s)", (strikes, minutes) => {
    expect(penaltyMinutesFor(strikes, CFG)).toBe(minutes);
  });

  it("el primer abandono no bloquea: puede ser una desconexión real", async () => {
    const { book: strikes } = book();

    const penalty = await strikes.add("t1", "u1");

    expect(penalty.strikes).toBe(1);
    expect(penalty.blockedUntil).toBe(0);
    expect(await strikes.isBlocked("t1", "u1")).toBe(false);
  });

  it("el segundo sí, y por los minutos de la escalera", async () => {
    const { book: strikes, clock } = book();
    await strikes.add("t1", "u1");

    const penalty = await strikes.add("t1", "u1");

    expect(penalty.blockedUntil).toBe(clock.now + 10 * MINUTE);
    expect(await strikes.isBlocked("t1", "u1")).toBe(true);
  });

  it("cumplido el plazo deja de bloquear, pero el contador sigue", async () => {
    const { book: strikes, clock } = book();
    await strikes.add("t1", "u1");
    await strikes.add("t1", "u1");

    clock.now += 10 * MINUTE + 1;

    expect(await strikes.isBlocked("t1", "u1")).toBe(false);
    expect((await strikes.penaltyOf("t1", "u1")).strikes).toBe(2); // el tercero pesará 20 min, no 10
  });

  it("el contador se olvida solo: mide reincidencia, no historia", async () => {
    const { book: strikes, clock } = book();
    await strikes.add("t1", "u1");
    await strikes.add("t1", "u1");

    clock.now += CFG.strikesDecayMs;

    expect((await strikes.penaltyOf("t1", "u1")).strikes).toBe(0);
    expect((await strikes.add("t1", "u1")).blockedUntil).toBe(0); // vuelve a ser el primero
  });

  it("el decaimiento cuenta desde el ÚLTIMO strike: reincidir sostenidamente sí escala", async () => {
    const { book: strikes, clock } = book();
    await strikes.add("t1", "u1");

    // Right before it is forgotten, another walkout renews the clock.
    clock.now += CFG.strikesDecayMs - 1;
    expect((await strikes.add("t1", "u1")).strikes).toBe(2);

    clock.now += CFG.strikesDecayMs - 1;
    expect((await strikes.add("t1", "u1")).strikes).toBe(3);
  });

  it("los strikes son POR TORNEO: abandonar en uno no penaliza en otro", async () => {
    const { book: strikes } = book();
    await strikes.add("t1", "u1");
    await strikes.add("t1", "u1");

    expect(await strikes.isBlocked("t1", "u1")).toBe(true);
    expect(await strikes.isBlocked("t2", "u1")).toBe(false);
  });
});
