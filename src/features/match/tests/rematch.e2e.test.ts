import { casualVeto } from "@/di-container";
import { CASUAL_SCOPE } from "@/features/matchmaking";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state";
import {
  type SeatedMatch,
  bootServer,
  clientOf,
  playUntilDecided,
  revealHands,
  seatPairAsMatchmaking,
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
//
// SE ABRE COMO LA ABRE EL EMPAREJADOR y no con un `CreateMatchRequest`, y no es un detalle del
// arnés: la sala distingue los dos caminos, y sólo el de las opciones trae la economía de la
// mesa. Creada por request, `roomOptions` queda en `undefined` y el sink de la revancha ni se
// engancha — o sea que la ventana se abriría y la mesa nueva no existiría nunca.
async function playedOut(seats: [string, string]): Promise<SeatedMatch> {
  // LA MESA ES GRATIS, y son dos motivos que se suman. El primero es que sin `BACKEND_URL` la
  // admisión de una mesa PAGA falla al entrar —`accountOf` no tiene a quién preguntarle— y
  // nadie llega a jugar. El segundo es que `isEligible` de una mesa sin inscripción ni consulta
  // la billetera, así que `eligible` llega ENCENDIDO y estos tests miden la revancha en vez de
  // medir que falta un backend.
  const match = await seatPairAsMatchmaking(server, seats, {
    entryFee: 0,
    prize: 0,
    isFreeRoom: true,
  });
  await revealHands(match);
  await playUntilDecided(match);
  await waitUntil(() => match.serverState.phase === "REMATCH_WINDOW", 5_000);
  return match;
}

// ⚠ EL `playerId` DE UNA MESA ABIERTA POR EL EMPAREJADOR ES EL ID DE CUENTA, no el `seat-N`
// opaco: `configFromRoomOptions` sienta a cada `options.seats[i]` con su propio nombre. Es la
// otra diferencia entre los dos caminos de creación —`configOf`, el del request, sí reparte
// `seat-N`— y es la que hace que estos tests hablen de `r1` y no de `seat-1`.

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

    await waitUntil(() => seenByClient(match, "r1").phase === "REMATCH_WINDOW", 3_000);
    // El nodo VIAJA, que es lo único que este test no comparte con el del motor: `eligible`,
    // `requesterId` y `acceptedIds` son lo que el front lee para decidir qué pantalla mostrar.
    expect(seenByClient(match, "r1").rematch).toBeDefined();
    expect(seenByClient(match, "r1").rematch?.requesterId).toBe("");
  });

  it("pedir y aceptar deja la mesa en el traspaso, y los dos clientes lo ven", async () => {
    const match = await playedOut(["r3", "r4"]);
    const [one, two] = ["r3", "r4"];

    clientOf(match, one).send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);
    // El que NO pidió tiene que poder distinguir «me están preguntando» de «pedí y espero», y
    // eso sale del `requesterId` sincronizado.
    await waitUntil(() => seenByClient(match, two).rematch?.requesterId === one, 3_000);
    expect(seenByClient(match, two).rematch?.responderId).toBe(two);

    clientOf(match, two).send("RESPOND_REMATCH", { accept: true });

    await waitUntil(() => match.serverState.phase === "REMATCH_ACCEPTED", 3_000);
    await waitUntil(() => seenByClient(match, one).phase === "REMATCH_ACCEPTED", 3_000);
  });

  // LA PRUEBA DE QUE LA REVANCHA EXISTE: cada uno recibe SU reserva de la mesa nueva, por su
  // propio socket. Sin esto, todo lo anterior es una negociación que no lleva a ninguna parte.
  //
  it("cada uno recibe su reserva de la mesa nueva, y sólo la suya", async () => {
    const match = await playedOut(["r11", "r12"]);
    const [one, two] = ["r11", "r12"];
    const reservations: Record<string, unknown[]> = { [one]: [], [two]: [] };
    for (const seat of [one, two]) {
      clientOf(match, seat).onMessage("REMATCH_SEAT", (payload: unknown) =>
        reservations[seat]?.push(payload),
      );
    }

    clientOf(match, one).send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);
    clientOf(match, two).send("RESPOND_REMATCH", { accept: true });

    await waitUntil(
      () => reservations[one]?.length === 1 && reservations[two]?.length === 1,
      5_000,
    );
    // Cada reserva nombra a SU dueño: la del otro no llega por este socket.
    expect((reservations[one]?.[0] as { sessionId?: string })?.sessionId).toBeDefined();
    expect(reservations[one]?.[0]).not.toEqual(reservations[two]?.[0]);
  });

  it("declinar apaga la mesa", async () => {
    const match = await playedOut(["r5", "r6"]);
    const [one, two] = ["r5", "r6"];
    clientOf(match, one).send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);

    clientOf(match, two).send("RESPOND_REMATCH", { accept: false });

    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);
    expect(match.serverState.rematch).toBeUndefined();
  });

  // EL QUE PIDE NO SE CONTESTA A SÍ MISMO, y por socket el rechazo tiene que llegar como
  // rechazo y no como silencio: el juez corre del lado del servidor, no del botón.
  it("el solicitante no puede aceptar su propia solicitud", async () => {
    const match = await playedOut(["r7", "r8"]);
    const [one] = ["r7", "r8"];
    clientOf(match, one).send("REQUEST_REMATCH", {});
    await waitUntil(() => match.serverState.phase === "REMATCH_NEGOTIATION", 3_000);

    // EL MENSAJE ES `illegal` Y NO `error`, que es la política de rechazo de la sala: un verbo
    // ilegal no es una falla del servidor, es una respuesta con su código.
    const rejected = new Promise<{ code: string }>((resolve) =>
      clientOf(match, one).onMessage("illegal", resolve),
    );
    clientOf(match, one).send("RESPOND_REMATCH", { accept: true });

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

  // ⚠ EL VETO, Y ES EL TEST QUE FALTABA CUANDO EL DEFECTO EXISTÍA. `matchmakingSink` escuchaba
  // `CASUAL_PAIR_VETOED` desde el port de matchmaking y NADIE lo emitía, así que el libro se
  // leía siempre vacío y el emparejador no evitaba a nadie nunca.
  //
  // No lo podía ver un test del productor —el defecto era que no se CONSTRUÍA— ni uno del
  // consumidor, que compilaba solo. Lo único que distingue las dos situaciones es leer el libro
  // del otro lado de la cadena entera: listener → evento → sink → `VetoBook.register`.
  //
  // La mesa nace con `rematchCount: 1`, o sea YA ES la revancha: terminar una partida normal no
  // veta a nadie, que es la regla que el otro `it` de `veto.test.ts` fija.
  it("una partida que YA ERA la revancha deja a los dos vetados para el emparejador", async () => {
    const match = await seatPairAsMatchmaking(server, ["v1", "v2"], {
      entryFee: 0,
      prize: 0,
      isFreeRoom: true,
      rematchCount: 1,
    });
    await revealHands(match);
    await playUntilDecided(match);

    await waitUntil(
      async () => (await casualVeto.vetoedFor(CASUAL_SCOPE, "v1")).includes("v2"),
      5_000,
    );

    expect(await casualVeto.vetoedFor(CASUAL_SCOPE, "v2")).toContain("v1");
  });
});
