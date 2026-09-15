import { describe, expect, it } from "vitest";
import { MemoryKeyValueStore } from "../../shared/kv.js";
import { DEFAULT_MAINTENANCE_MESSAGE } from "./core/state.js";
import { LobbySettings } from "./settings.js";

describe("LobbySettings", () => {
  it("nace disponible con el mensaje histórico", async () => {
    const settings = new LobbySettings(new MemoryKeyValueStore());

    expect(await settings.get()).toEqual({
      isUnderMaintenance: false,
      maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
    });
  });

  it("comparte el cambio con otra instancia", async () => {
    const store = new MemoryKeyValueStore();
    const writer = new LobbySettings(store);
    const reader = new LobbySettings(store);

    await writer.set({ isUnderMaintenance: true, maintenanceMessage: "Actualizando mesas" });

    expect(await reader.get()).toEqual({
      isUnderMaintenance: true,
      maintenanceMessage: "Actualizando mesas",
    });
  });

  it("cierra el acceso si el valor persistido está corrupto", async () => {
    const store = new MemoryKeyValueStore();
    await store.set("lobby:maintenance", "{");

    expect(await new LobbySettings(store).get()).toEqual({
      isUnderMaintenance: true,
      maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
    });
  });
});
