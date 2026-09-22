import type { ColyseusTestServer } from "@colyseus/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state";
import {
  type SeatedMatch,
  bootServer,
  clientOf,
  playUntilDecided,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

// LA REVANCHA POR EL CABLE. Lo que estos tests miden y el del motor no puede es el CAMINO: que
// los dos verbos estén ruteados, que el decoder los acepte, que el juez rechace lo ilegal por
// socket y que el árbol sincronizado le llegue al cliente con lo que el front necesita pintar.
//
// LA PARTIDA SE JUEGA ENTERA, de verdad, y no se empuja la fase a mano como en el test del
// motor. Es el precio de un E2E y acá se paga a propósito: lo que abre la ventana es el
// vencimiento de la pausa de presentación, que solo ocurre después de un veredicto real.

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2598);
});

afterEach(async () => {
  await server.cleanup();
});

// Una mesa jugada hasta el final, con la ventana ya abierta.
async function playedOut(seats: [string, string]): Promise<SeatedMatch> {
  const match = await seatPair(server, seats, `seed-${seats[0]}`);
  await revealHands(match);
  await playUntilDecided(match);
  await waitUntil(() => match.serverState.phase === "REMATCH_WINDOW", 5_000);
  return match;
}

// El árbol como lo ve un CLIENTE, que es el que importa: si el nodo no viaja, el front no
// puede pintar nada por más que el servidor lo tenga.
//
// El cast es el mismo que usan los otros E2E: el SDK decodifica por reflexión y tipa su
// `state` como `object`, así que sin esto el archivo corre verde en vitest y se cae en
// `typecheck`, que es el gate.
const seenByClient = (match: SeatedMatch, seat: string) =>
  clientOf(match, seat).state as MatchState;

describe("la revancha, de punta a punta", () => {
  it("al terminar la partida la ventana se abre y el cliente la ve", async () => {
    const match = await playedOut(["r1", "r2"]);

    await waitUntil(() => seenByClient(match, "seat-1").phase === "REMATCH_WINDOW", 3_000);
    // El nodo VIAJA, que es lo único que este test no comparte con el del motor: `eligible`,
    // `requesterId` y `acceptedIds` son lo que el front lee para decidir qué pantalla mostrar.
    expect(seenByClient(match, "seat-1").rematch).toBeDefined();
    expect(seenByClient(match, "seat-1").rematch?.requesterId).toBe("");
  });

  it("pedir y aceptar deja la mesa en el traspaso, y los dos clientes lo ven", async () => {
    const match = await playedOut(["r3", "r4"]);

    clientOf(match, "seat-1").send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);
    // El que NO pidió tiene que poder distinguir «me están preguntando» de «pedí y espero», y
    // eso sale del `requesterId` sincronizado.
    await waitUntil(() => seenByClient(match, "seat-2").rematch?.requesterId === "seat-1", 3_000);
    expect(seenByClient(match, "seat-2").rematch?.responderId).toBe("seat-2");

    clientOf(match, "seat-2").send("RESPOND_REMATCH", { accept: true });

    await waitUntil(() => match.serverState.phase === "REMATCH_ACCEPTED", 3_000);
    await waitUntil(() => seenByClient(match, "seat-1").phase === "REMATCH_ACCEPTED", 3_000);
  });

  it("declinar apaga la mesa", async () => {
    const match = await playedOut(["r5", "r6"]);
    clientOf(match, "seat-1").send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);

    clientOf(match, "seat-2").send("RESPOND_REMATCH", { accept: false });

    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);
    expect(match.serverState.rematch).toBeUndefined();
  });

  // EL QUE PIDE NO SE CONTESTA A SÍ MISMO, y por socket el rechazo tiene que llegar como
  // rechazo y no como silencio: el juez corre del lado del servidor, no del botón.
  it("el solicitante no puede aceptar su propia solicitud", async () => {
    const match = await playedOut(["r7", "r8"]);
    clientOf(match, "seat-1").send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);

    // EL MENSAJE ES `illegal` Y NO `error`, que es la política de rechazo de la sala: un verbo
    // ilegal no es una falla del servidor, es una respuesta con su código.
    const rejected = new Promise<{ code: string }>((resolve) =>
      clientOf(match, "seat-1").onMessage("illegal", resolve),
    );
    clientOf(match, "seat-1").send("RESPOND_REMATCH", { accept: true });

    expect((await rejected).code).toBe("NOT_YOUR_REMATCH");
    expect(match.serverState.phase).toBe("REMATCH_NEGOTIATION");
  });

  // NADIE PIDE: la ventana vence sola y la mesa se apaga. Es el camino que recorre la inmensa
  // mayoría de las partidas, así que es el que no puede colgarse.
  it("si nadie pide, la ventana vence y la mesa se apaga sola", async () => {
    const match = await playedOut(["r9", "r10"]);

    await waitUntil(() => match.serverState.phase === "FINISHED", 5_000);
    expect(match.serverState.rematch).toBeUndefined();
  });
});
