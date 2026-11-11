import { env } from "@/env";
import { mintAdminToken } from "@/tests/billing-auth-keys";
import { bootTestServer, casualTable, mintToken, waitUntil } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// EL CANARIO DE LAS AUDIENCIAS (`docs/convenciones/audiencias.md` del orquestador): una mesa cruzada
// entre el proveedor A y el proveedor B, con DOS CLIENTES REALES, donde todo lo privado de B lleva una
// marca única —`canario-b` en sus ids, el monto `987654.32` en una moneda que sólo él usa (`XCB`)—. Se
// recorre todo lo que alcanza A —el estado sincronizado y cada mensaje que recibe su cliente, y las
// rutas `/internal/matches*` con un token de admin de A— y nada puede traer una marca.
//
// LA EXCEPCIÓN ACEPTADA: del asiento rival se ven su nombre visible, su usuario, su equipo y sus
// jugadas. Por eso el nombre y el usuario de B no llevan marca. Su FOTO sí: el dominó la reenvía tal
// cual la recibe en `participants[].profilePicture`, y en una mesa cruzada el orquestador ya la manda
// sellada por su proxy (`/v1/avatars/<token>`); acá se mide que sea la única marca que aparece, y sólo
// en `profilePicture`.
const PORT = 2612;
const base = `http://127.0.0.1:${PORT}`;
const CANARY = /canario-b|987654|XCB/;
const PHOTO_B = "https://img.test/canario-b-foto.png";

const priceB = {
  currency: "XCB",
  rate: "98765.432",
  entry: "987654.32",
  prize: "1975308.64",
  levels: [],
};
const table = {
  ...casualTable([
    {
      userId: "ana-a",
      displayName: "Ana",
      currency: "VES",
      providerId: "prov-a",
      price: { currency: "VES", rate: "200", entry: "2000.00", prize: "3600.00", levels: [] },
    },
    {
      userId: "canario-b-user",
      displayName: "Rival",
      username: "rival",
      profilePicture: PHOTO_B,
      currency: "XCB",
      providerId: "canario-b-prov",
      price: priceB,
    },
  ]),
  matchId: "m-audiencias",
};

type Opened = {
  data: { roomId: string; seats: { userId: string; reservation: Record<string, unknown> }[] };
};

/** Lo que A recibe, sin la foto de B (la excepción): ahí no puede quedar ninguna marca. */
const withoutPhoto = (wire: string) => wire.split(PHOTO_B).join("<foto-del-rival>");

describe("audiencias: lo que alcanza el proveedor A en una mesa cruzada con B", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
  });
  afterAll(async () => {
    await server.shutdown();
  }, 30_000);

  it("ni el estado, ni los mensajes, ni el registro le llevan nada privado de B", async () => {
    const opened = await fetch(`${base}/internal/matches`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": env.orchestratorApiKey ?? "",
      },
      body: JSON.stringify(table),
    });
    expect(opened.status).toBe(201);
    const { data } = (await opened.json()) as Opened;
    const reservationOf = (userId: string) =>
      data.seats.find((seat) => seat.userId === userId)?.reservation as never;

    // EL CLIENTE DE A, con TODO lo que le llega anotado: cada mensaje, de cualquier tipo. El handler se
    // registra en el mismo turno en que resuelve el `join`, así que el `config` no se escapa.
    server.sdk.auth.token = mintToken("ana-a");
    const roomA = await server.sdk.consumeSeatReservation(reservationOf("ana-a"));
    const received: string[] = [];
    roomA.onMessage("*", (type: unknown, message: unknown) => {
      received.push(JSON.stringify({ type, message }));
    });
    const states: string[] = [];
    const snapshot = () => states.push(JSON.stringify(roomA.state));

    server.sdk.auth.token = mintToken("canario-b-user");
    const roomB = await server.sdk.consumeSeatReservation(reservationOf("canario-b-user"));
    roomB.onMessage("*", () => {});

    await waitUntil(() => received.some((line) => line.includes('"config"')));
    await waitUntil(() => (roomA.state as { players?: unknown[] }).players?.length === 2);
    snapshot();

    roomA.send("REVEAL_TILES", {});
    roomB.send("REVEAL_TILES", {});
    await waitUntil(
      () =>
        (roomA.state as { currentRound?: { phase?: string } }).currentRound?.phase === "PLAYING",
    );
    snapshot();

    // B SE RINDE: la partida cierra con veredicto, plata y registro.
    roomB.send("ABANDON", {});
    await waitUntil(() => received.some((line) => line.includes("MATCH_RESOLVED")));
    snapshot();

    // EL MENSAJE `config` DE A: la mesa y SU asiento, con su precio, y nada de B.
    const config = received.find((line) => line.includes('"config"')) ?? "";
    expect(JSON.parse(config).message.seat).toEqual({
      playerId: "seat-1",
      price: {
        currency: "VES",
        rateId: table.rateId,
        rate: "200",
        entry: "2000.00",
        prize: "3600.00",
        levels: [],
      },
    });

    for (const line of [...received, ...states]) {
      expect(withoutPhoto(line)).not.toMatch(CANARY);
      expect(line).not.toContain("ana-a");
      expect(line).not.toContain("prov-a");
    }
    // La foto de B, si viaja, viaja en su `profilePicture` y nada más (la sella el orquestador).
    expect(states.join("")).toContain(PHOTO_B);

    // EL REGISTRO, con un token de admin de A: el listado y el detalle, y las rutas de Tablea cerradas.
    const tablea = { authorization: `Bearer ${mintAdminToken("tablea")}` };
    const asA = {
      authorization: `Bearer ${mintAdminToken("pia", { prv: "prov-a", role: "admin" })}`,
    };
    const detailPath = `/internal/matches/${table.matchId}`;
    await waitUntil(async () => {
      const response = await fetch(`${base}${detailPath}`, { headers: tablea });
      if (response.status !== 200) return false;
      const body = (await response.json()) as { data: { status?: string; players?: unknown } };
      return body.data.status === "finished" && body.data.players !== undefined;
    }, 5_000);

    const all = await (await fetch(`${base}${detailPath}`, { headers: tablea })).text();
    // EL CONTROL DEL CANARIO: Tablea sí lo ve todo, así que la ausencia de abajo no es casualidad.
    expect(all).toContain("canario-b-user");
    expect(all).toContain("987654.32");

    for (const path of [
      "/internal/matches",
      `/internal/matches?matchId=${table.matchId}`,
      detailPath,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: asA });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(table.matchId);
      expect(text).not.toMatch(CANARY);
    }
    for (const path of [`${detailPath}/history`, `/game-data/${data.roomId}`]) {
      expect((await fetch(`${base}${path}`, { headers: asA })).status).toBe(403);
    }

    await Promise.all([roomA.leave(), roomB.leave()]);
  });
});
