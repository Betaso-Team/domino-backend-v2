import { census } from "@/di-container";
import { bootTestServer, casualTable, joinAs } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// CUÁNTOS ESTÁN JUGANDO, para la pantalla de lobby del que todavía no tiene sesión. Lo que cuenta
// son ASIENTOS vivos del clúster, que no es lo que v1 servía con otro nombre — de ahí el otro nombre.
//
// El censo se resuelve de `@/di-container` y no de un token: es la MISMA instancia que
// `matchmakingHttp` recibió al armar la app, y el test empuja su pasada a mano en vez de
// esperar el intervalo real.
describe("endpoint GET /players-in-match (integración)", () => {
  let server: ColyseusTestServer;

  const asked = () => server.http.get("/players-in-match");

  beforeAll(async () => {
    server = await bootTestServer(2596);
  });

  afterAll(async () => {
    await server.shutdown();
  });

  afterEach(async () => {
    await server.cleanup();
    await census.check();
  });

  // SIN TOKEN a propósito: la pantalla que pregunta es la que todavía no puede iniciar sesión, y un
  // número agregado no dice nada de nadie.
  it("contesta sin pedir credencial", async () => {
    await census.check();

    expect((await asked()).data).toEqual({ playersInMatch: 0 });
  });

  it("cuenta los asientos de una partida viva", async () => {
    const room = await server.createRoom("domino", casualTable(["censo-a", "censo-b"]));
    await joinAs(server, room.roomId, "censo-a");
    await joinAs(server, room.roomId, "censo-b");

    await census.check();

    expect((await asked()).data).toEqual({ playersInMatch: 2 });
  });

  // Solo sale el número del CLÚSTER. Los otros dos del cartel se saben adentro del proceso que
  // sostiene el lobby, y un request HTTP cae en el proceso que el balanceador haya elegido.
  it("no publica los contadores que solo el lobby conoce", async () => {
    const res = await asked();

    expect(res.data).not.toHaveProperty("playersInLobby");
    expect(res.data).not.toHaveProperty("playersSearching");
    expect(res.data).not.toHaveProperty("byGameMode");
  });
});
