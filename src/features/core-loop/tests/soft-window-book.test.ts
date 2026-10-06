import { MemoryKeyValueStore } from "@/shared/kv";
import { describe, expect, it } from "vitest";
import { SoftWindowBook } from "../soft-window-book";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function build(startAt = 1000) {
  const clock = { now: startAt };
  const kv = new MemoryKeyValueStore(() => clock.now);
  return { book: new SoftWindowBook(kv, TTL_MS), clock };
}

describe("SoftWindowBook", () => {
  it("sin nota, no está en ventana", async () => {
    expect(await build().book.remainingFor("u1")).toBe(0);
  });

  it("registra el remanente que core-loop devolvió", async () => {
    const { book } = build();

    await book.record("u1", 4);

    expect(await book.remainingFor("u1")).toBe(4);
  });

  it("remanente en 0 borra la nota en vez de escribir un cero", async () => {
    const { book } = build();
    await book.record("u1", 4);

    await book.record("u1", 0);

    expect(await book.remainingFor("u1")).toBe(0);
  });

  it("caduca: nadie queda protegido para siempre por un TTL local", async () => {
    const { book, clock } = build();
    await book.record("u1", 4);

    clock.now += TTL_MS;

    expect(await book.remainingFor("u1")).toBe(0);
  });
});
