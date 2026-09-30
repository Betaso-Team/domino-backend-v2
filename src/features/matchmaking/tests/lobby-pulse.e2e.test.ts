import { rootContainer } from "@/di-container";
import { bootTestServer, mintToken } from "@/tests/e2e";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MATCHMAKING_CONFIG } from "../config";

// EL PULSO DEL CARTEL SALE DE `censusPollMs` y no de un cinco escrito en la sala (truco `96970aa`).
// Coincidían por convención: el censo se refresca cada `censusPollMs` y el cartel se publicaba cada
// cinco segundos, así que cambiar uno dejaba al otro publicando números viejos o repitiendo el mismo.
//
// Se lee AL NACER LA SALA, por eso el registro va antes de que exista ningún lobby: lo que se mide es
// que el cartel late solo al ritmo configurado, no el ritmo de producción.
const PORT = 2613;

describe("el cartel del lobby late al ritmo del censo", () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await bootTestServer(PORT);
    rootContainer.register("MatchmakingConfig", {
      useValue: { ...DEFAULT_MATCHMAKING_CONFIG, censusPollMs: 100 },
    });
  });

  afterAll(async () => {
    rootContainer.register("MatchmakingConfig", { useValue: DEFAULT_MATCHMAKING_CONFIG });
    await server.shutdown();
  });

  // Con el cinco de antes, en un segundo llegan a lo sumo los dos del saludo (el de `onCreate` y el
  // de `onJoin`); con 100 ms llegan muchos más sin que nadie entre ni salga.
  it("publica LOBBY_STATS cada censusPollMs sin que nadie entre ni salga", async () => {
    server.sdk.auth.token = mintToken("mirón");
    const lobby = await server.sdk.joinOrCreate("lobby", {});
    let heard = 0;
    lobby.onMessage("LOBBY_STATS", () => {
      heard += 1;
    });

    await vi.waitFor(() => expect(heard).toBeGreaterThanOrEqual(5), { timeout: 2_000 });
    await lobby.leave();
  });
});
