import express from "express";
import { describe, expect, it } from "vitest";
import { exposeServerTime } from "./server-time";

// CONTRA UN EXPRESS DE VERDAD Y CON `fetch`, igual que `health.test.ts`: lo que hay que
// medir es la cabecera que sale POR EL CABLE. Un handler invocado a mano no produce
// respuesta HTTP, y esta pieza no hace otra cosa que ponerle una cabecera a esa respuesta.
async function serve() {
  const app = express();
  app.use(exposeServerTime());
  app.get("/cualquiera", (_req, res) => void res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("el servidor no ató puerto");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    get: (path: string) => fetch(`${base}${path}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("exposeServerTime", () => {
  it("expone `Date` para que un origen distinto pueda leerla", async () => {
    const server = await serve();
    try {
      const response = await server.get("/cualquiera");

      expect(response.headers.get("access-control-expose-headers")).toBe("Date");
      // La cabecera que se expone tiene que EXISTIR: la manda Node solo, y si algún día
      // dejara de mandarla el permiso quedaría apuntando a nada.
      expect(response.headers.get("date")).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});
