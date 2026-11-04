import { describe, expect, it } from "vitest";
import { REACTION_PACKS, StaticReactionCatalog } from "../static-catalog";

// LA LISTA ES UN CONTRATO CON EL FRONT: el orden es el del selector y el id es lo que viaja. Este
// test la escribe de nuevo a mano a propósito: cambiar un dibujo, un id o el orden tiene que pedir
// cambiar las dos cosas.
const EXPECTED = [
  "😀",
  "😂",
  "😎",
  "😍",
  "😡",
  "😭",
  "👍",
  "👎",
  "🙏",
  "💪",
  "✌️",
  "🔥",
  "💤",
  "🤔",
  "😴",
  "🤯",
  "😱",
  "😤",
  "😈",
  "💀",
  "🏆",
  "💵",
  "💰",
  "🤑",
];

const items = REACTION_PACKS.flatMap(({ items }) => items);

describe("el catálogo de reacciones del dominó", () => {
  it("es un solo paquete, `global`, con los 24 emojis en orden", () => {
    expect(REACTION_PACKS.map(({ pack }) => pack)).toEqual(["global"]);
    expect(items.map(({ content }) => content)).toEqual(EXPECTED);
    expect(items.every(({ type }) => type === "emoji")).toBe(true);
  });

  // ✌️ son DOS code points (U+270C + el selector de variación U+FE0F). Sin el selector, algunos
  // teclados lo dibujan como texto y no como emoji.
  it("el ✌️ lleva el selector de variación", () => {
    expect(items.find(({ id }) => id === "victory")?.content).toBe("✌️");
  });

  // Los ids caben en lo que acepta `SEND_REACTION` (1 a 64) y son slugs ASCII: un id que el cable no
  // puede llevar sería un gesto imposible de mandar.
  it("los ids son únicos, ASCII y de hasta 64", () => {
    const ids = items.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it("encuentra un gesto por id, y no inventa uno que no está", async () => {
    const catalog = new StaticReactionCatalog();

    await expect(catalog.find("fire")).resolves.toEqual({
      id: "fire",
      type: "emoji",
      content: "🔥",
    });
    await expect(catalog.find("me-lo-invente")).resolves.toBeUndefined();
    // El prototipo no es un gesto.
    await expect(catalog.find("toString")).resolves.toBeUndefined();
  });

  // Lo que sirve `GET /reactions` es la misma lista, sin campos de más.
  it("la lista entera tiene la forma del cable: { pack, items: [{ id, type, content }] }", async () => {
    const packs = await new StaticReactionCatalog().packs();

    expect(packs).toEqual(REACTION_PACKS);
    for (const reaction of packs.flatMap(({ items }) => items)) {
      expect(Object.keys(reaction).sort()).toEqual(["content", "id", "type"]);
    }
  });
});
