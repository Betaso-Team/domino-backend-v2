import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REACTION_PACKS, StaticReactionCatalog } from "../static-catalog";
import { REACTIONS_ROUTE, reactionsHttp } from "./http";

// LA RUTA CONTRA EL CATÁLOGO DE VERDAD, el mismo que la sala consulta: lo que el front dibuja y lo
// que el servidor acepta salen de la misma lista.
let close: () => void;
let base: string;

beforeAll(async () => {
  const app = express().use(reactionsHttp({ catalog: new StaticReactionCatalog() }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(() => close());

describe("GET /reactions", () => {
  it("es pública y devuelve [{ pack: 'global', items: [{ id, type, content }] }]", async () => {
    const response = await fetch(`${base}${REACTIONS_ROUTE}`);

    expect(REACTIONS_ROUTE).toBe("/reactions");
    expect(response.status).toBe(200);
    const body = (await response.json()) as typeof REACTION_PACKS;
    expect(body).toEqual(REACTION_PACKS);
    expect(body).toHaveLength(1);
    expect(body[0]?.pack).toBe("global");
    expect(body[0]?.items).toHaveLength(24);
    expect(body[0]?.items[0]).toEqual({ id: "grin", type: "emoji", content: "😀" });
  });

  it("se puede guardar cinco minutos en cualquier caché", async () => {
    const response = await fetch(`${base}${REACTIONS_ROUTE}`);

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
