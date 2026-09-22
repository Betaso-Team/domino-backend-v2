import { maintenanceSignal } from "@/di-container";
import { env } from "@/env";
import { bootTestServer } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL CARTEL del mantenimiento. La otra mitad —la PUERTA, que es la que corta el acceso de verdad—
// se mide con el emparejador; acá solo se asierta que el front puede saber qué mostrar.
//
// SE EMPUJA POR EL ENDPOINT INTERNO Y NO SUSTITUYENDO EL LIBRO, que es donde este archivo se aparta
// de su gemelo de truco. Allá el libro es un token del container y el test registra el suyo; acá
// `PolledMaintenanceSignal` se construye UNA vez en `di-container.ts` sobre un libro elegido por la
// presencia de `MONGO_URI` —que `vitest.setup.ts` borra—, así que registrar un token después del
// arranque no llegaría a ningún lado.
//
// Lo que queda es mejor: sin base, el libro lee `LobbySettings`, o sea la misma clave que
// `POST /internal/lobby/maintenance` escribe. El test recorre entonces la cadena ENTERA —el panel
// escribe, la pasada lee, el endpoint contesta— en vez de saltearse las dos primeras.
describe("endpoint GET /maintenance (integración)", () => {
  let server: ColyseusTestServer;

  const close = async (message: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/lobby/maintenance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": env.internalApiKey ?? "" },
      body: JSON.stringify({ isUnderMaintenance: true, message }),
    });
    expect(res.status).toBe(200);
    // La pasada a mano: el intervalo real es de segundos y esperarlo sería el test durmiendo.
    await maintenanceSignal.check();
  };

  const port = 2594;

  beforeAll(async () => {
    server = await bootTestServer(port);
  });

  afterAll(async () => {
    await fetch(`http://127.0.0.1:${port}/internal/lobby/maintenance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": env.internalApiKey ?? "" },
      body: JSON.stringify({ isUnderMaintenance: false }),
    });
    await maintenanceSignal.check();
    await server.shutdown();
  });

  // ABIERTO ES UNA RESPUESTA Y NO SILENCIO: el cliente tiene UN solo camino de código en vez de dos,
  // y no tiene que inferir de la ausencia de mensaje que todo está bien.
  it("con el juego abierto contesta que lo está", async () => {
    expect((await server.http.get("/maintenance")).data).toEqual({
      isUnderMaintenance: false,
      message: "",
    });
  });

  // SIN CREDENCIAL, y es el único de los tres endpoints que lo es: «¿está abierto?» es justamente la
  // pregunta que hay que poder hacer antes de tener con qué autenticarse.
  it("dice si el juego está cerrado, y con qué mensaje, sin pedir credencial", async () => {
    await close("Volvemos a las 18");

    expect((await server.http.get("/maintenance")).data).toEqual({
      isUnderMaintenance: true,
      message: "Volvemos a las 18",
    });
  });
});
