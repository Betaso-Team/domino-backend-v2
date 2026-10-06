import { MemoryKeyValueStore } from "@/shared/kv";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import type { CoreLoopSettings, CoreLoopSettingsSource } from "../settings";
import { SoftProfileResolver, type WinrateSource } from "../soft-profile";
import { SoftWindowBook } from "../soft-window-book";

const ON: CoreLoopSettings = {
  enabled: true,
  rake0Matches: 5,
  softWindowMatches: 10,
  winrateCeiling: 0.6,
  minSampleForWinrateFilter: 10,
  softTimeoutSeconds: 35,
};

type Stats = Awaited<ReturnType<WinrateSource["statsOf"]>>;
const stats = (over: Partial<Stats> = {}): Stats => ({ gamesPlayed: 20, winRate: 0.75, ...over });

function build(
  options: { settings?: CoreLoopSettings; statsOf?: (playerId: string) => Promise<Stats> } = {},
) {
  const statsCalls: string[] = [];
  const settingsSource: CoreLoopSettingsSource = { settings: async () => options.settings ?? ON };
  const statsOf =
    options.statsOf ??
    (async (playerId: string) => {
      statsCalls.push(playerId);
      return stats();
    });
  const softWindow = new SoftWindowBook(new MemoryKeyValueStore(() => 1000), 60_000);
  const log = new MemoryLogger();
  const resolver = new SoftProfileResolver(
    settingsSource,
    softWindow,
    { statsOf },
    5_000,
    () => 1000,
    log,
  );
  return { resolver, softWindow, log, statsCalls };
}

describe("SoftProfileResolver", () => {
  it("apagado: neutro sin tocar la ventana ni el winrate", async () => {
    const { resolver, statsCalls } = build({ settings: { ...ON, enabled: false } });

    expect(await resolver.profileOf("u1")).toEqual({ inSoftWindow: false, isShark: false });
    expect(statsCalls).toEqual([]);
  });

  it("en ventana: lo dice el remanente de la ventana blanda", async () => {
    const { resolver, softWindow } = build();
    await softWindow.record("u1", 4);

    expect((await resolver.profileOf("u1")).inSoftWindow).toBe(true);
    expect((await resolver.profileOf("u2")).inSoftWindow).toBe(false);
  });

  it("shark: winrate por encima del techo Y muestra suficiente", async () => {
    const { resolver } = build({ statsOf: async () => stats({ gamesPlayed: 20, winRate: 0.75 }) });

    expect((await resolver.profileOf("u1")).isShark).toBe(true);
  });

  // `minSampleForWinrateFilter` hace doble función (v1, soft-profile.service.ts): además de no juzgar
  // a nadie por tres partidas, es lo que deja que dos novatos SÍ se crucen.
  it("sin muestra suficiente, no es shark aunque gane siempre", async () => {
    const { resolver } = build({ statsOf: async () => stats({ gamesPlayed: 3, winRate: 1 }) });

    expect((await resolver.profileOf("u1")).isShark).toBe(false);
  });

  it("bajo el techo de winrate, no es shark aunque tenga muestra de sobra", async () => {
    const { resolver } = build({ statsOf: async () => stats({ gamesPlayed: 50, winRate: 0.5 }) });

    expect((await resolver.profileOf("u1")).isShark).toBe(false);
  });

  // FALLA ABIERTA, al revés que el resto de core-loop (v1, soft-profile.service.ts): un perfil que
  // falta es un dato ausente, no un rival prohibido.
  it("sin winrate disponible (falla la consulta): no filtra, y lo dice", async () => {
    const { resolver, log } = build({
      statsOf: async () => {
        throw new Error("mongo caído");
      },
    });

    expect((await resolver.profileOf("u1")).isShark).toBe(false);
    expect(log.at_("error")).not.toHaveLength(0);
  });

  it("cachea el winrate: dos consultas a la vez no son dos recorridos del historial", async () => {
    const { resolver, statsCalls } = build();

    await Promise.all([resolver.profileOf("u1"), resolver.profileOf("u1")]);
    await resolver.profileOf("u1");

    expect(statsCalls).toEqual(["u1"]);
  });
});
