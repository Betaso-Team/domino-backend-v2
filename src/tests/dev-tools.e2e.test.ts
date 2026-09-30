import { bootTestServer } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Sólo que están montadas: la suite corre como `local` (sin `APP_ENV` y sin `NODE_ENV=production`),
// uno de los dos entornos que las sirven. Que NO se monten en stage y prod lo decide
// `isDevEnvironment`, medido en `src/env.test.ts`.
const PORT = 2612;

describe("las herramientas de Colyseus para probar a mano (integración)", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it("el playground responde con las salas vivas", async () => {
    const res = await fetch(`http://localhost:${PORT}/playground/rooms`);

    expect(res.status).toBe(200);
  });

  it("el monitor responde con las salas vivas", async () => {
    const res = await fetch(`http://localhost:${PORT}/monitor/api`);

    expect(res.status).toBe(200);
  });
});
