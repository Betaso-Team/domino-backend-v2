import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  act,
  bootServer,
  casualTable,
  historyOf,
  linesOf,
  mintToken,
  revealHands,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2585);
});

afterAll(async () => {
  await server.shutdown();
});

describe("ciclo de vida de una partida", () => {
  it("la partida arranca sola al ocuparse el último asiento", async () => {
    const match = await seatPair(server, ["u1", "u2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    expect(match.serverState.startedAt).toBeGreaterThan(0);
    expect(match.serverState.players.map((player) => player.playerId)).toEqual(["u1", "u2"]);
    expect(match.serverState.players.map((player) => player.teamId)).toEqual(["A", "B"]);
  });

  it("abandonar cierra la partida por forfeit, y el historial queda intercalado", async () => {
    const match = await seatPair(server, ["a1", "a2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    await act(match, "a1", "ABANDON");
    expect(match.serverState.phase).toBe("PRESENTING_MATCH");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

    expect(linesOf("m-a1-a2")).toEqual([
      "PLAYER ABANDON",
      "SYSTEM MATCH_RESOLVED",
      "SYSTEM DEADLINE_EXPIRED",
    ]);
    const resolved = historyOf("m-a1-a2").find((entry) => entry.type === "MATCH_RESOLVED");
    expect(resolved?.payload).toEqual({ winnerTeamId: "B", reason: "ABANDONMENT" });
  });

  it("el seq no tiene huecos y es estrictamente creciente", async () => {
    const match = await seatPair(server, ["s1", "s2"]);
    await act(match, "s1", "ABANDON");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

    const seqs = historyOf("m-s1-s2").map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it("un verbo desconocido se rechaza y no entra al historial", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    const illegal: unknown[] = [];
    match.clients.r1?.onMessage("illegal", (payload) => illegal.push(payload));
    match.clients.r1?.send("DROP_TABLE", {});

    await waitUntil(() => illegal.length > 0);
    expect(illegal[0]).toEqual({ code: "UNKNOWN_COMMAND" });
    expect(historyOf("m-r1-r2")).toHaveLength(0);
    expect(match.serverState.phase).toBe("PLAYING");
  });

  it("un mensaje llamado toString no mata la mesa", async () => {
    const match = await seatPair(server, ["p1", "p2"]);
    const illegal: unknown[] = [];
    match.clients.p1?.onMessage("illegal", (payload) => illegal.push(payload));
    match.clients.p1?.send("toString", {});

    await waitUntil(() => illegal.length > 0);
    expect(illegal[0]).toEqual({ code: "UNKNOWN_COMMAND" });
    expect(match.serverState.phase).toBe("PLAYING");
  });

  it("una segunda conexión del mismo asiento desplaza a la primera", async () => {
    const match = await seatPair(server, ["d1", "d2"]);
    server.sdk.auth.token = mintToken("d1");
    await server.sdk.joinById(match.roomId);
    await waitUntil(() => server.getRoomById(match.roomId).clients.length === 2);

    expect(linesOf("m-d1-d2").filter((line) => line.includes("PLAYER_DISCONNECTED"))).toEqual([]);
  });

  it("quien no tiene asiento no entra", async () => {
    const room = await server.createRoom("domino", casualTable(["x1", "x2"]));
    server.sdk.auth.token = mintToken("x1");
    await server.connectTo(room);
    server.sdk.auth.token = mintToken("intruso");

    await expect(server.connectTo(room)).rejects.toThrow();
    expect(server.getRoomById(room.roomId)).toBeDefined();
  });

  it("sin token no entra", async () => {
    const room = await server.createRoom("domino", casualTable(["y1", "y2"]));
    await server.sdk.auth.signOut();

    await expect(server.connectTo(room)).rejects.toThrow();
  });

  it("el endpoint de config responde el DTO sin seed", async () => {
    const match = await seatPair(server, ["c1", "c2"], "seed-secretisimo");
    const response = await fetch(`http://localhost:2585/config/${match.roomId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("seed-secretisimo");
    expect(JSON.parse(body)).toEqual({
      matchId: "m-c1-c2",
      gameModeId: "clasica-2p",
      seats: ["c1", "c2"],
      pointsToWin: 100,
      serverNow: expect.any(Number),
    });
  });

  it("el config trae una muestra actual del reloj del servidor", async () => {
    const match = await seatPair(server, ["t1", "t2"]);
    const before = Date.now();
    const body = (await (await fetch(`http://localhost:2585/config/${match.roomId}`)).json()) as {
      serverNow: number;
    };
    const after = Date.now();

    expect(body.serverNow).toBeGreaterThanOrEqual(before);
    expect(body.serverNow).toBeLessThanOrEqual(after);
  });

  // El endpoint de SOPORTE: es de dónde sale el historial que después se rebobina.
  // Se indexa por matchId y no por roomId a propósito — la sala muere y la partida no.
  it("el endpoint interno devuelve el historial de la partida", async () => {
    const match = await seatPair(server, ["h1", "h2"]);
    await revealHands(match);

    const response = await fetch("http://localhost:2585/internal/matches/m-h1-h2/history");
    const body = (await response.json()) as { matchId: string; entries: { type: string }[] };

    expect(response.status).toBe(200);
    expect(body.matchId).toBe("m-h1-h2");
    expect(body.entries.map((entry) => entry.type)).toEqual(["REVEAL_TILES", "REVEAL_TILES"]);
  });

  it("una partida sin historial es 404 y no un cuerpo vacío", async () => {
    const response = await fetch("http://localhost:2585/internal/matches/m-no-existe/history");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });
});
