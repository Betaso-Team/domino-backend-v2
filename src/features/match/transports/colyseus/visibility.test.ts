import { Encoder, StateView } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import { InvariantViolationError } from "../../core/engine/errors";
import { Hand, Tile } from "../../core/state";
import { StateViewVisibilityController } from "./visibility";

function build() {
  const views = new Map([
    ["u1", new StateView()],
    ["u2", new StateView()],
  ]);
  return { views, controller: new StateViewVisibilityController(views) };
}

function tile(): Tile {
  const value = new Tile();
  new Encoder(value);
  return value;
}

describe("StateViewVisibilityController", () => {
  it("revela una ficha solo al asiento indicado", () => {
    const { views, controller } = build();
    const value = tile();

    controller.makePublic(value, { kind: "PLAYER", playerId: "u1" });

    expect(views.get("u1")?.has(value)).toBe(true);
    expect(views.get("u2")?.has(value)).toBe(false);
  });

  it("revela una ficha a todos los asientos", () => {
    const { views, controller } = build();
    const value = tile();

    controller.makePublic(value, { kind: "ALL" });

    expect(views.get("u1")?.has(value)).toBe(true);
    expect(views.get("u2")?.has(value)).toBe(true);
  });

  it("oculta una ficha al asiento indicado", () => {
    const { views, controller } = build();
    const value = tile();
    controller.makePublic(value, { kind: "ALL" });

    controller.hide(value, { kind: "PLAYER", playerId: "u2" });

    expect(views.get("u1")?.has(value)).toBe(true);
    expect(views.get("u2")?.has(value)).toBe(false);
  });

  it("revela y oculta una colección completa", () => {
    const { views, controller } = build();
    const hand = new Hand();
    hand.tiles.push(new Tile());
    new Encoder(hand);

    controller.makePublic(hand.tiles, { kind: "PLAYER", playerId: "u1" });
    expect(views.get("u1")?.has(hand.tiles)).toBe(true);

    controller.hide(hand.tiles, { kind: "PLAYER", playerId: "u1" });
    expect(views.get("u1")?.has(hand.tiles)).toBe(false);
  });

  it("revela al asiento aunque todavía no tenga conexión", () => {
    const { views, controller } = build();
    const value = tile();

    controller.makePublic(value, { kind: "PLAYER", playerId: "u2" });

    expect(views.get("u2")?.has(value)).toBe(true);
  });

  it("repetir una revelación global es idempotente", () => {
    const { views, controller } = build();
    const value = tile();

    controller.makePublic(value, { kind: "ALL" });
    controller.makePublic(value, { kind: "ALL" });

    expect(views.get("u1")?.has(value)).toBe(true);
  });

  it("PLAYER para un asiento ausente lanza una invarianta con el id", () => {
    const { controller } = build();
    const value = tile();

    expect(() => controller.makePublic(value, { kind: "PLAYER", playerId: "u9" })).toThrow(
      new InvariantViolationError("sin vista para el asiento u9"),
    );
  });
});
