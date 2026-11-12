import { rootContainer } from "@/di-container";
import type { MemoryReactionUsage, ReactionSent, ReactionUsageStore } from "@/features/reactions";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type SeatedMatch,
  act,
  bootServer,
  clientOf,
  linesOf,
  playerIdOf,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness";

// LAS REACCIONES de punta a punta, con clientes reales y la app ensamblada. Lo que prueba —además de
// la feature— es la frontera que la hizo posible: un mensaje que NO es un verbo del dominó entra por
// el mismo socket, pasa por el mismo router y llega a su handler, sin que el motor sepa qué es.
// Portado de truco (`f8713f3`).
const PORT = 2593;
const FIRE = { id: "fire", type: "emoji", content: "🔥" } as const;

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(PORT);
});

afterAll(async () => {
  await server.shutdown();
});

const heardBy = (match: SeatedMatch, selector: string) => {
  const heard: ReactionSent[] = [];
  clientOf(match, selector).onMessage("REACTION_SENT", (sent: ReactionSent) => heard.push(sent));
  return heard;
};

const illegalOf = (match: SeatedMatch, selector: string) => {
  const illegal: Array<{ code: string }> = [];
  clientOf(match, selector).onMessage("illegal", (m: { code: string }) => illegal.push(m));
  return illegal;
};

// Se le da tiempo a que lleguen todos los mensajes que fueran a llegar antes de contar.
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe("Reacciones end-to-end", () => {
  // Se difunde a TODOS, el que lo mandó incluido, y `fromPlayerId` es el `seat-N` del asiento: el
  // mismo `PlayerState.playerId` que el front ya usa para ubicar a cada jugador en la mesa.
  it("el gesto le llega a los dos, con el asiento que lo mandó y el contenido del catálogo", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    const mine = heardBy(match, "r1");
    const theirs = heardBy(match, "r2");

    clientOf(match, "r1").send("SEND_REACTION", { reactionId: FIRE.id });

    await waitUntil(() => theirs.length === 1 && mine.length === 1);
    const seat = playerIdOf(match, "r1");
    expect(seat).toMatch(/^seat-\d+$/);
    expect(theirs[0]).toEqual({ fromPlayerId: seat, reaction: FIRE });
    expect(mine).toEqual(theirs);
    expect(match.serverState.players.find((p) => p.playerId === seat)?.userId).toBe("r1");
  });

  // El contenido lo pone el SERVIDOR, no el cliente. Acá está la diferencia entre esto y un chat: un
  // id que el catálogo no conoce no sale a la mesa, y al que lo mandó no se le contesta nada.
  it("un id que no está en el catálogo no llega a nadie, y no devuelve error", async () => {
    const match = await seatPair(server, ["ri1", "ri2"]);
    const theirs = heardBy(match, "ri2");
    const illegal = illegalOf(match, "ri1");

    clientOf(match, "ri1").send("SEND_REACTION", { reactionId: "me-lo-invente" });
    // Se manda uno bueno detrás: si el malo hubiera salido, llegaría primero.
    clientOf(match, "ri1").send("SEND_REACTION", { reactionId: FIRE.id });

    await waitUntil(() => theirs.length === 1);
    await settle();
    expect(theirs).toEqual([{ fromPlayerId: playerIdOf(match, "ri1"), reaction: FIRE }]);
    expect(illegal).toEqual([]);
  });

  // Un cable malformado se rechaza con el MISMO código que un verbo malformado: el cliente aprende un
  // solo juego de códigos, no uno por clase de mensaje. Lo que sobra (el `targetPlayerId` del front
  // viejo) no es malformado: se ignora.
  it("sin reactionId es MALFORMED; un campo de más se ignora", async () => {
    const match = await seatPair(server, ["rm1", "rm2"]);
    const illegal = illegalOf(match, "rm1");
    const theirs = heardBy(match, "rm2");

    clientOf(match, "rm1").send("SEND_REACTION", {});
    await waitUntil(() => illegal.length === 1);
    expect(illegal).toEqual([expect.objectContaining({ code: "MALFORMED" })]);

    clientOf(match, "rm1").send("SEND_REACTION", { reactionId: FIRE.id, targetPlayerId: "seat-2" });
    await waitUntil(() => theirs.length === 1);
    expect(theirs[0]?.reaction).toEqual(FIRE);
  });

  // EL LÍMITE: tres cada dos segundos por jugador. Silencioso a propósito: un gesto que no sale no es
  // un error que la pantalla tenga que dibujar.
  it("el bombardeo se corta en la ráfaga, sin devolver error, y el otro sigue pudiendo", async () => {
    const match = await seatPair(server, ["rs1", "rs2"]);
    const theirs = heardBy(match, "rs2");
    const illegal = illegalOf(match, "rs1");

    for (let i = 0; i < 10; i++)
      clientOf(match, "rs1").send("SEND_REACTION", { reactionId: FIRE.id });
    await waitUntil(() => theirs.length > 0);
    await settle();
    expect(theirs).toHaveLength(3);
    expect(illegal).toEqual([]);

    clientOf(match, "rs2").send("SEND_REACTION", { reactionId: "skull" });
    await waitUntil(() => theirs.length === 4);
    expect(theirs[3]?.fromPlayerId).toBe(playerIdOf(match, "rs2"));
  });

  // Y no toca la partida: el gesto no es un acto del juego. Ni mueve el estado, ni produce `events`,
  // ni entra en el historial.
  it("no produce eventos de la partida, no mueve el turno y no entra en el historial", async () => {
    const match = await seatPair(server, ["rh1", "rh2"]);
    await revealHands(match);
    const events: unknown[] = [];
    clientOf(match, "rh2").onMessage("events", (batch: unknown) => events.push(batch));
    const turnBefore = match.serverState.currentRound?.currentTurn?.playerId;
    const linesBefore = await linesOf(match.config.matchId);
    const theirs = heardBy(match, "rh2");

    clientOf(match, "rh1").send("SEND_REACTION", { reactionId: FIRE.id });
    await waitUntil(() => theirs.length === 1);
    await settle();

    expect(events).toEqual([]);
    expect(match.serverState.currentRound?.currentTurn?.playerId).toBe(turnBefore);
    expect(await linesOf(match.config.matchId)).toEqual(linesBefore);
  });

  // EN CUALQUIER FASE mientras la sala esté abierta: también en la pantalla del resultado.
  it("se puede reaccionar con la partida ya decidida", async () => {
    const match = await seatPair(server, ["rf1", "rf2"]);
    await revealHands(match);
    await act(match, "rf1", "ABANDON");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);
    const mine = heardBy(match, "rf2");

    clientOf(match, "rf2").send("SEND_REACTION", { reactionId: "trophy" });

    await waitUntil(() => mine.length === 1);
    expect(mine[0]).toEqual({
      fromPlayerId: playerIdOf(match, "rf2"),
      reaction: { id: "trophy", type: "emoji", content: "🏆" },
    });
  });

  // EL REGISTRO DE USO, de punta a punta: sin `MONGO_URI` la app ensamblada usa la memoria. Un gesto
  // deja una fila con el jugador de Tablea, y un silenciado reenviado con el mismo `eventId` (el que
  // genera el cliente) deja una sola.
  it("una reacción y un silenciado repetido dejan una fila cada uno", async () => {
    const usage = rootContainer.resolve<ReactionUsageStore>(
      "ReactionUsageStore",
    ) as MemoryReactionUsage;
    const match = await seatPair(server, ["ru1", "ru2"]);
    const theirs = heardBy(match, "ru2");
    const eventId = "3f2b8c1e-7a4d-4e9b-9c2f-1d0e5a6b7c80";

    clientOf(match, "ru1").send("SEND_REACTION", { reactionId: FIRE.id });
    clientOf(match, "ru1").send("REACTIONS_MUTE_CHANGED", { muted: true, eventId });
    clientOf(match, "ru1").send("REACTIONS_MUTE_CHANGED", { muted: true, eventId });

    const ofMatch = <T extends { matchId: string }>(rows: readonly T[]) =>
      rows.filter((row) => row.matchId === match.config.matchId);
    await waitUntil(
      () =>
        theirs.length === 1 &&
        ofMatch(usage.reactions()).length === 1 &&
        ofMatch(usage.muteChanges()).length === 1,
    );
    await settle();
    expect(ofMatch(usage.reactions())).toEqual([
      expect.objectContaining({
        userId: "ru1",
        matchId: match.config.matchId,
        gameKind: "paga",
        reactionId: "fire",
        emoji: "🔥",
      }),
    ]);
    expect(ofMatch(usage.muteChanges())).toEqual([
      expect.objectContaining({ eventId, userId: "ru1", muted: true, origin: "partida" }),
    ]);
  });

  it("un silenciado sin eventId uuid es MALFORMED y no se registra", async () => {
    const usage = rootContainer.resolve<ReactionUsageStore>(
      "ReactionUsageStore",
    ) as MemoryReactionUsage;
    const match = await seatPair(server, ["rx1", "rx2"]);
    const illegal = illegalOf(match, "rx1");

    clientOf(match, "rx1").send("REACTIONS_MUTE_CHANGED", { muted: true, eventId: "no-es-uuid" });
    await waitUntil(() => illegal.length === 1);
    expect(illegal).toEqual([expect.objectContaining({ code: "MALFORMED" })]);
    expect(usage.muteChanges().filter((row) => row.matchId === match.config.matchId)).toEqual([]);
  });

  // LA LISTA QUE EL FRONT DIBUJA, en la app ensamblada: pública, sin credencial.
  it("GET /reactions está montada, sin credencial y cacheable", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/reactions`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const [pack, ...rest] = (await response.json()) as Array<{ pack: string; items: unknown[] }>;
    expect(rest).toEqual([]);
    expect(pack?.pack).toBe("global");
    expect(pack?.items).toHaveLength(24);
    expect(pack?.items).toContainEqual(FIRE);
  });
});
