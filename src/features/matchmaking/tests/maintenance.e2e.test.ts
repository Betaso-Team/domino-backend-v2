import { maintenanceSignal, matchmaker } from "@/di-container";
import { env } from "@/env";
import { bootTestServer, mintToken, waitUntil } from "@/tests/e2e";
import { FREE_2P } from "@/tests/game-mode-catalog";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Maintenance, OPEN } from "../maintenance";

// EL EMPUJE, de punta a punta y con clientes reales: producto mueve la palanca y el front se entera
// SIN preguntar. Es lo que la puerta sola no da — rechazar al que pide no le dice nada al que está
// mirando el botón sin apretarlo todavía.
//
// LA PALANCA SE MUEVE POR EL ENDPOINT INTERNO y no sustituyendo el libro del container, por el mismo
// motivo que en `maintenance-endpoint.e2e.test.ts`: la señal se construye una sola vez al armar el
// container. Sin base, su libro lee `LobbySettings`, que es lo que ese endpoint escribe.

const CERRADO: Maintenance = { isUnderMaintenance: true, message: "Volvemos a las 18" };
const PORT = 2595;

describe("Mantenimiento end-to-end: el lobby avisa sin que le pregunten", () => {
  let server: ColyseusTestServer;

  // Mueve la palanca y fuerza la pasada. El intervalo real es de segundos: esperarlo sería el test
  // durmiendo, y lo que se mide no es el reloj sino que la pasada empuje.
  const set = async (maintenance: Maintenance) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/internal/lobby/maintenance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": env.internalApiKey ?? "" },
      body: JSON.stringify(
        maintenance.isUnderMaintenance
          ? { isUnderMaintenance: true, message: maintenance.message }
          : { isUnderMaintenance: false },
      ),
    });
    expect(res.status).toBe(200);
    await maintenanceSignal.check();
  };

  const joinLobby = async (userId: string) => {
    server.sdk.auth.token = mintToken(userId);
    const lobby = await server.sdk.joinOrCreate("lobby", {});
    const heard: Maintenance[] = [];
    lobby.onMessage("MAINTENANCE", (m: Maintenance) => heard.push(m));
    return { lobby, heard };
  };

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });

  afterAll(async () => {
    await set(OPEN);
    await server.shutdown();
  });

  // EL SALUDO. Se manda siempre, abierto o cerrado: le deja al cliente un camino de código en vez de
  // dos, y le ahorra tener que inferir del silencio que todo está bien.
  it("al entrar al lobby te dice cómo está, sin que preguntes", async () => {
    await set(OPEN);

    const { heard } = await joinLobby("u1");

    await vi.waitFor(() => expect(heard).toEqual([OPEN]));
  });

  // EL EMPUJE. El jugador YA estaba en el lobby cuando producto apretó: nadie le preguntó nada y se
  // entera igual, con el texto que producto escribió.
  it("si se cierra mientras estás dentro, te llega el aviso con su mensaje", async () => {
    await set(OPEN);
    const { heard } = await joinLobby("u2");
    await vi.waitFor(() => expect(heard).toHaveLength(1));

    await set(CERRADO);

    await vi.waitFor(() => expect(heard.at(-1)).toEqual(CERRADO));
  });

  // Y la vuelta importa tanto como la ida: sin esto el front quedaría bloqueado hasta que alguien
  // recargue la página.
  it("y cuando vuelve a abrir, también", async () => {
    await set(CERRADO);
    const { heard } = await joinLobby("u3");
    await vi.waitFor(() => expect(heard).toEqual([CERRADO]));

    await set(OPEN);

    await vi.waitFor(() => expect(heard.at(-1)).toEqual(OPEN));
  });

  // LA PUERTA, por el camino real del cliente. El aviso bloquea la UI; esto es lo que pasa si se
  // intenta igual —un cliente viejo, una carrera— y es por qué el cartel solo no alcanza.
  it("y pedir partida con el juego cerrado se rechaza con MAINTENANCE", async () => {
    await set(CERRADO);
    const { lobby } = await joinLobby("u4");

    const rejected = new Promise<{ reason: string }>((resolve) => {
      lobby.onMessage("MATCHMAKING_ERROR", resolve);
    });
    lobby.send("REQUEST_MATCH", { kind: "CASUAL", gameModeId: FREE_2P.uuid });

    expect(await rejected).toEqual({ reason: "MAINTENANCE" });
  });

  // Al que YA estaba en la cola cuando se cerró no lo dejan esperando en silencio hasta que su
  // búsqueda venza: sale con la razón, en la misma pasada que detectó el cambio.
  //
  // LA MESA ES LA GRATIS Y NO LA PAGA, y es la diferencia con truco que este archivo no puede
  // esquivar: sin `BACKEND_URL` el `canAfford` del container contesta `false` siempre, así que una
  // mesa con inscripción saldría con `INSUFFICIENT_FUNDS` antes de llegar a la cola — y el test
  // mediría la billetera creyendo que mide el vaciado.
  it("al que ya estaba esperando lo sacan de la cola con su razón", async () => {
    await set(OPEN);
    const { lobby } = await joinLobby("u5");

    const rejected = new Promise<{ reason: string }>((resolve) => {
      lobby.onMessage("MATCHMAKING_ERROR", resolve);
    });
    lobby.send("REQUEST_MATCH", { kind: "CASUAL", gameModeId: FREE_2P.uuid });
    // SE ESPERA A QUE ESTÉ EN LA COLA DE VERDAD, y no un plazo fijo. Con un `setTimeout` este
    // test mide la PUERTA en vez del vaciado el día que la máquina vaya lenta —y pasa verde
    // igual, porque los dos caminos devuelven `MAINTENANCE`—. Preguntarle a la cola es además
    // lo único que distingue los dos casos desde afuera.
    await waitUntil(async () => (await matchmaker.waiting()).total === 1);

    await set(CERRADO);

    expect(await rejected).toEqual({ reason: "MAINTENANCE" });
  });
});
