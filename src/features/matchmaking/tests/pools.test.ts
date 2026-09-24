import type { GameMode, GameModeReader } from "@/features/game-mode";
import { DEFAULT_TOURNAMENT_CONFIG, StrikeBook, type TournamentInfo } from "@/features/tournament";
import { MemoryKeyValueStore } from "@/shared/kv";
import { FakeTournamentClient } from "@/tests/fake-client";
import { FakeWallet } from "@/tests/fake-wallet";
import { beforeEach, describe, expect, it } from "vitest";
import { MatchmakingError } from "../errors";
import type { Ticket } from "../pool";
import { ScopedPoolDirectory } from "../pools/directory";

// What each scope contributes to matchmaking. The sibling of the tournament pieces' test: the same
// idea from the other side of a match.

// EL CATÁLOGO DE ESTE ARCHIVO, y vive acá adentro por dos razones que se suman.
//
// La primera es que `MemoryGameModeRepository` —el adaptador de memoria del catálogo, que NO es un
// doble— genera el `uuid` en cada `create()`, así que no hay forma de escribir `gameModeId: "paga"`
// en el request y que el modo aparezca. Lo que estas filas miden es qué hace el pool con CADA
// combinación de campos, no cómo el catálogo asigna identificadores.
//
// La segunda es la Regla 4: el equivalente de truco vive en `features/game-modes/tests/`, y
// `feature-boundary` prohíbe que matchmaking importe archivos internos de otra feature. Con un solo
// consumidor no vale un archivo en `src/tests/`: iría ahí el día que aparezca el segundo.
//
// Lee por `byUuid` y devuelve también los inactivos a propósito: `casualPoolSpec` distingue
// `POOL_NOT_FOUND` de `POOL_CLOSED`, y un lector que escondiera los dados de baja colapsaría los
// dos motivos en uno.
const modeOf = (over: Partial<GameMode>): GameMode => ({
  id: `id-${over.uuid}`,
  uuid: "x",
  name: "Mesa",
  multiplier: 1,
  prize: 0,
  entryFee: 0,
  playersQuantity: 2,
  pointsToWin: 12,
  isActive: true,
  isFreeRoom: false,
  enableBots: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  version: 0,
  ...over,
});

const TABLES: readonly GameMode[] = [
  modeOf({ uuid: "paga", name: "Paga", entryFee: 10, prize: 18, pointsToWin: 12 }),
  modeOf({ uuid: "gratis", name: "Gratis", pointsToWin: 9, isFreeRoom: true }),
  modeOf({ uuid: "apagada", name: "Apagada", entryFee: 10, prize: 18, isActive: false }),
];

class ListGameModeReader implements GameModeReader {
  private readonly byId: ReadonlyMap<string, GameMode>;

  constructor(modes: readonly GameMode[]) {
    // Congelado en el constructor: un catálogo que cualquiera pueda mutar desde afuera dejaría que
    // dos mesas del mismo modo nazcan a precios distintos.
    this.byId = new Map(modes.map((mode) => [mode.uuid, Object.freeze({ ...mode })]));
  }

  async active(): Promise<readonly GameMode[]> {
    return [...this.byId.values()].filter(({ isActive }) => isActive);
  }

  async all(): Promise<readonly GameMode[]> {
    return [...this.byId.values()];
  }

  async activeByUuid(uuid: string): Promise<GameMode | undefined> {
    const mode = this.byId.get(uuid);
    return mode?.isActive ? mode : undefined;
  }

  async byUuid(uuid: string): Promise<GameMode | undefined> {
    return this.byId.get(uuid);
  }
}

const TOURNAMENT_ID = "t1";
const INFO: TournamentInfo = {
  status: "IN_GAME",
  name: "Torneo",
  pointsPerLoss: 1,
  playersQuantity: 2,
  pointsToWin: 12,
};

const ticket = (playerId: string): Ticket => ({
  playerId,
  poolId: "x",
  request: { kind: "CASUAL", gameModeId: "x" },
  enqueuedAt: 0,
  avoid: [],
});

const reasonOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "NO_LANZÓ";
  } catch (e) {
    return e instanceof MatchmakingError ? e.reason : "OTRO_ERROR";
  }
};

describe("Los pools por ámbito", () => {
  let wallet: FakeWallet;
  let client: FakeTournamentClient;
  let strikes: StrikeBook;
  let directory: ScopedPoolDirectory;

  beforeEach(() => {
    wallet = new FakeWallet();
    client = new FakeTournamentClient();
    client.setInfo(TOURNAMENT_ID, INFO);
    client.enroll(TOURNAMENT_ID, "t-u1");
    strikes = new StrikeBook(new MemoryKeyValueStore(), DEFAULT_TOURNAMENT_CONFIG, () =>
      Date.now(),
    );
    directory = new ScopedPoolDirectory(
      { catalog: new ListGameModeReader(TABLES), wallet, avoid: async () => [] },
      { client, strikes, avoid: async () => [] },
    );
  });

  describe("casual", () => {
    it("los números de la partida salen de la MESA, no de la cantidad de asientos", async () => {
      const spec = await directory.specOf({ kind: "CASUAL", gameModeId: "gratis" });

      expect(spec).toMatchObject({ poolId: "gratis", seats: 2, pointsToWin: 9 });
      expect(spec.toRoomOptions([ticket("u1"), ticket("u2")], "seed")).toMatchObject({
        mode: "CASUAL",
        pointsToWin: 9,
        entryFee: 0,
        prize: 0,
      });
    });

    it("sin saldo no se entra a la cola", async () => {
      wallet.setBalance("pelado", 3);

      const spec = await directory.specOf({ kind: "CASUAL", gameModeId: "paga" });

      expect(await reasonOf(() => spec.admit({ playerId: "pelado", token: "t" }))).toBe(
        "INSUFFICIENT_FUNDS",
      );
    });

    // Refusing here and not at the room's admission is what avoids dragging the rival in: bouncing
    // them afterwards opens and closes a match the other already believed was theirs.
    it("en mesa gratis no se le pregunta el saldo a nadie", async () => {
      wallet.setBalance("pelado", 0);

      const spec = await directory.specOf({ kind: "CASUAL", gameModeId: "gratis" });

      await expect(spec.admit({ playerId: "pelado", token: "t" })).resolves.toBeUndefined();
    });

    it("una mesa apagada y una inexistente se distinguen", async () => {
      expect(
        await reasonOf(() => directory.specOf({ kind: "CASUAL", gameModeId: "apagada" })),
      ).toBe("POOL_CLOSED");
      expect(await reasonOf(() => directory.specOf({ kind: "CASUAL", gameModeId: "nada" }))).toBe(
        "POOL_NOT_FOUND",
      );
    });

    // The ORDER the grouping decided IS the team assignment, so translating to options cannot reorder
    // anything.
    it("el orden del grupo llega intacto a los asientos", async () => {
      const spec = await directory.specOf({ kind: "CASUAL", gameModeId: "gratis" });

      const options = spec.toRoomOptions(["u3", "u1", "u4", "u2"].map(ticket), "seed");

      expect(options.seats).toEqual(["u3", "u1", "u4", "u2"]);
    });
  });

  describe("torneo", () => {
    it("no está inscrito: la autorización la dictamina el backend principal", async () => {
      const spec = await directory.specOf({ kind: "TOURNAMENT", tournamentId: TOURNAMENT_ID });

      expect(await reasonOf(() => spec.admit({ playerId: "u2", token: "t-u2" }))).toBe(
        "NOT_ENROLLED",
      );
      await expect(spec.admit({ playerId: "u1", token: "t-u1" })).resolves.toBeUndefined();
    });

    // The walkout penalty is charged at the queue's DOOR, the only place where it means anything.
    it("el penalizado no entra a la cola", async () => {
      await strikes.add(TOURNAMENT_ID, "u1");
      await strikes.add(TOURNAMENT_ID, "u1"); // el segundo abandono ya penaliza

      const spec = await directory.specOf({ kind: "TOURNAMENT", tournamentId: TOURNAMENT_ID });

      expect(await reasonOf(() => spec.admit({ playerId: "u1", token: "t-u1" }))).toBe("PENALIZED");
    });

    it("un torneo que no está jugándose no empareja", async () => {
      client.setInfo(TOURNAMENT_ID, { ...INFO, status: "FINISHED" });

      expect(
        await reasonOf(() => directory.specOf({ kind: "TOURNAMENT", tournamentId: TOURNAMENT_ID })),
      ).toBe("POOL_CLOSED");
    });

    it("un torneo inexistente se distingue de uno cerrado", async () => {
      expect(
        await reasonOf(() => directory.specOf({ kind: "TOURNAMENT", tournamentId: "fantasma" })),
      ).toBe("POOL_NOT_FOUND");
    });

    // THE flexibility requirement: tournaments are 1v1 today, and four-seat ones tomorrow have to be a
    // piece of DATA the main backend serves and not a change in this code.
    it("la cantidad de asientos la dicta el TORNEO, no una constante", async () => {
      client.setInfo(TOURNAMENT_ID, { ...INFO, playersQuantity: 4, pointsToWin: 24 });

      const spec = await directory.specOf({ kind: "TOURNAMENT", tournamentId: TOURNAMENT_ID });

      expect(spec).toMatchObject({ seats: 4, pointsToWin: 24 });
      expect(spec.toRoomOptions(["u1", "u2", "u3", "u4"].map(ticket), "seed")).toMatchObject({
        mode: "TOURNAMENT",
        tournamentId: TOURNAMENT_ID,
        pointsToWin: 24,
        pointsPerLoss: 1,
      });
    });
  });
});
