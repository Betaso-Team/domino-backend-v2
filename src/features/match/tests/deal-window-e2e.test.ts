import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import {
  type SeatedMatch,
  act,
  bootServer,
  clientOf,
  historyOf,
  linesOf,
  playerIdOf,
  seatPair,
  waitUntil,
} from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2590);
});

afterAll(async () => {
  await server.shutdown();
});

// El SELECTOR es el `userUuid` con el que el test nombra a la gente; adentro del árbol los
// jugadores se llaman `seat-N`, así que traducirlo no es opcional: sin `playerIdOf` la
// búsqueda no encuentra a nadie y el `waitUntil` se cuelga en vez de fallar.
const seenOf = (match: SeatedMatch, state: MatchState, selector: string): boolean =>
  state.players.find((player) => player.playerId === playerIdOf(match, selector))?.hasSeenTiles ??
  false;

const revealTiles = async (match: SeatedMatch, selector: string): Promise<void> => {
  clientOf(match, selector).send("REVEAL_TILES", {});
  await waitUntil(() => seenOf(match, match.serverState, selector));
};

const tilesSeenBy = (match: SeatedMatch, viewerId: string, ownerId: string) => [
  ...((clientOf(match, viewerId).state as MatchState).players.find(
    (player) => player.playerId === playerIdOf(match, ownerId),
  )?.hand.tiles ?? []),
];

const playerStateOf = (match: SeatedMatch, selector: string) =>
  match.serverState.players.find((player) => player.playerId === playerIdOf(match, selector));

describe("ventana de reparto", () => {
  it("reparte tapado y espera a que ambos levanten antes de dar el turno", async () => {
    const match = await seatPair(server, ["deal-d1", "deal-d2"]);

    expect(match.serverState.currentRound?.phase).toBe("DEALING");
    // El reloj de la ventana SE ARMÓ. Sin esta línea, el `activeDeadline === 0` del
    // cuarto test no distingue "el plazo se apagó" de "nunca se encendió".
    expect(match.serverState.activeDeadline).toBeGreaterThan(0);
    expect(match.serverState.players.map((player) => player.hand.tileCount)).toEqual([7, 7]);
    expect(tilesSeenBy(match, "deal-d1", "deal-d1")).toHaveLength(0);
    expect(tilesSeenBy(match, "deal-d2", "deal-d2")).toHaveLength(0);

    await revealTiles(match, "deal-d1");

    expect(seenOf(match, match.serverState, "deal-d1")).toBe(true);
    expect(seenOf(match, match.serverState, "deal-d2")).toBe(false);
    expect(match.serverState.currentRound?.phase).toBe("DEALING");

    await act(match, "deal-d2", "REVEAL_TILES");

    expect(match.serverState.currentRound?.phase).toBe("PLAYING");
    expect(match.serverState.currentRound?.currentTurn?.playerId).toBeTruthy();
  });

  it("revelar hace visible la mano solo para su dueño", async () => {
    const match = await seatPair(server, ["deal-v1", "deal-v2"]);

    await revealTiles(match, "deal-v1");
    await waitUntil(
      () =>
        tilesSeenBy(match, "deal-v1", "deal-v1").length === 7 &&
        seenOf(match, clientOf(match, "deal-v2").state as MatchState, "deal-v1"),
    );

    expect(tilesSeenBy(match, "deal-v1", "deal-v1")).toHaveLength(7);
    expect(tilesSeenBy(match, "deal-v2", "deal-v1")).toHaveLength(0);
  });

  it("retira al ausente y resuelve por forfeit cuando solo uno levanta", async () => {
    const match = await seatPair(server, ["deal-f1", "deal-f2"]);
    const matchId = "m-deal-f1-deal-f2";

    await revealTiles(match, "deal-f1");
    await waitUntil(() => playerStateOf(match, "deal-f2")?.hasAbandoned === true, 5_000);

    const winnerTeamId = playerStateOf(match, "deal-f1")?.teamId;
    // Al presente NO lo retiran: el forfeit es del que no levantó, y solo de él.
    expect(playerStateOf(match, "deal-f1")?.hasAbandoned).toBe(false);
    expect(await linesOf(matchId)).toContain("SYSTEM ABANDON");
    expect(await linesOf(matchId)).toContain("SYSTEM MATCH_RESOLVED");
    expect(
      (await historyOf(matchId)).find((entry) => entry.type === "MATCH_RESOLVED")?.payload,
    ).toEqual({
      winnerTeamId,
      reason: "ABANDONMENT",
    });
  }, 7_000);

  it("si nadie levanta abandona a ambos, no inventa ganador y aborta como NEVER_PLAYED", async () => {
    const match = await seatPair(server, ["deal-z1", "deal-z2"]);
    const matchId = "m-deal-z1-deal-z2";

    await waitUntil(() => match.serverState.players.every((player) => player.hasAbandoned), 5_000);

    expect((await linesOf(matchId)).filter((line) => line === "SYSTEM ABANDON")).toHaveLength(2);
    expect(await linesOf(matchId)).not.toContain("SYSTEM MATCH_RESOLVED");
    expect(match.serverState.phase).not.toBe("FINISHED");
    expect(match.serverState.activeDeadline).toBe(0);

    await server.getRoomById(match.roomId).disconnect();
    await waitUntil(async () => (await linesOf(matchId)).includes("SYSTEM MATCH_ABORTED"), 5_000);

    const aborted = (await historyOf(matchId)).find((entry) => entry.type === "MATCH_ABORTED");
    expect(aborted).toBeDefined();
    expect(aborted?.source).toBe("SYSTEM");
    expect(aborted?.kind).toBe("EVENT");
    // `toEqual` y no `toMatchObject`: el payload del aborto es el motivo del reembolso
    // y nada más. Con `toMatchObject` un campo agregado mañana entra sin que nadie se
    // entere, y este es el registro que respalda no haber pagado el premio.
    expect(aborted?.payload).toEqual({ reason: "NEVER_PLAYED" });
  }, 7_000);
});
