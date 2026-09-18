import { describe, expect, it, vi } from "vitest";
import { CommandCatalog } from "../catalog";

// LA FRONTERA ANTI-TRAMPA YA NO SE PRUEBA ACÁ: se fue con `accepts()` al router, y su test
// —incluido el de los nombres del prototipo— vive en `../../messages.test.ts`. Lo que el
// catálogo conserva es ser los dos mapas del motor, y eso es lo que queda fijado acá.
const build = () =>
  new CommandCatalog(
    {
      ABANDON: { decode: vi.fn(() => ({ playerId: "u1" })) },
      PLAY_TILE: {
        decode: vi.fn(() => ({ playerId: "u1", left: 6, right: 6, side: "RIGHT" as const })),
      },
      DRAW_TILE: { decode: vi.fn(() => ({ playerId: "u1" })) },
      PASS: { decode: vi.fn(() => ({ playerId: "u1" })) },
      REVEAL_TILES: { decode: vi.fn(() => ({ playerId: "u1" })) },
      PROPOSE_BET_MULTIPLIER: { decode: vi.fn(() => ({ playerId: "u1", level: 1 })) },
      RESPOND_BET_MULTIPLIER: { decode: vi.fn(() => ({ playerId: "u1", accept: true })) },
    },
    {
      ABANDON: { execute: vi.fn(() => []) },
      PLAY_TILE: { execute: vi.fn(() => []) },
      DRAW_TILE: { execute: vi.fn(() => []) },
      PASS: { execute: vi.fn(() => []) },
      REVEAL_TILES: { execute: vi.fn(() => []) },
      PROPOSE_BET_MULTIPLIER: { execute: vi.fn(() => []) },
      RESPOND_BET_MULTIPLIER: { execute: vi.fn(() => []) },
    },
  );

describe("CommandCatalog", () => {
  it("entrega el decoder del verbo pedido", () => {
    const catalog = build();

    expect(catalog.decoder("ABANDON")).toBe(catalog.decoder("ABANDON"));
    expect(catalog.decoder("PLAY_TILE")).not.toBe(catalog.decoder("PASS"));
  });

  it("entrega el comando del verbo pedido", () => {
    const catalog = build();

    expect(catalog.command("PLAY_TILE")).not.toBe(catalog.command("PASS"));
  });

  // LO QUE HACE QUE NINGÚN VERBO SE QUEDE SIN RUTEAR. `buildRouter` recorre esta lista, así
  // que un verbo que el motor gane y el catálogo no declare no llega por el cable — y el
  // tipo mapeado sobre `CommandName` hace que ni siquiera compile olvidarse de uno.
  it("sus nombres son la lista de verbos que el router registra", () => {
    expect([...build().names()].sort()).toEqual([
      "ABANDON",
      "DRAW_TILE",
      "PASS",
      "PLAY_TILE",
      "PROPOSE_BET_MULTIPLIER",
      "RESPOND_BET_MULTIPLIER",
      "REVEAL_TILES",
    ]);
  });
});
