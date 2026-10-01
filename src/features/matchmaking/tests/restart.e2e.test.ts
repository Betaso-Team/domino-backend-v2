import { matchmaker } from "@/di-container";
import { bootTestServer, mintToken } from "@/tests/e2e";
import { FREE_2P } from "@/tests/game-mode-catalog";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL APAGADO ORDENADO, desde la silla del cliente. La cola vive en el proceso que cierra, así que la
// búsqueda no se puede trasladar — y el que esperaba tiene que enterarse, en vez de quedarse con la
// ruedita girando sobre un socket que está por morir. Portado de truco (`4fa5061`).
//
// Es un E2E y no un test del emparejador porque lo que está en duda es justo lo que el emparejador no
// ve: que su rechazo viaje entero hasta afuera —`reasonOf` de la sala del lobby incluido— y LLEGUE
// antes de que el servidor se lleve el socket.
const PORT = 2599;

describe("El apagado end-to-end: al que esperaba se le avisa", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    // De vuelta en pie: el emparejador es del PROCESO, y uno detenido dejaría sin emparejar a lo que
    // corra después en este worker.
    matchmaker.start();
    await server.shutdown();
  });

  it("el que estaba buscando recibe RESTARTING, y no el comodín", async () => {
    server.sdk.auth.token = mintToken("u1");
    const lobby = await server.sdk.joinOrCreate("lobby", {});
    const refused = new Promise<{ reason: string }>((resolve) => {
      lobby.onMessage("MATCHMAKING_ERROR", resolve);
    });

    // Mesa GRATIS: sin backend la billetera contesta que no alcanza, y el rechazo saldría en la
    // puerta —`INSUFFICIENT_FUNDS`— antes de que haya una cola que vaciar.
    lobby.send("REQUEST_MATCH", { kind: "CASUAL", gameModeId: FREE_2P.uuid });
    // Encolado DE VERDAD antes de cerrar: sin esto lo que se mide es la puerta y no el vaciado. El
    // lobby no acusa el encolado, así que se le da el margen que truco le da.
    await new Promise((resolve) => setTimeout(resolve, 150));

    matchmaker.stop();

    expect(await refused).toEqual({ reason: "RESTARTING" });
  });
});
