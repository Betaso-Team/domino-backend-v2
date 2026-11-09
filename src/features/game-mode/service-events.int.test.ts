import type { Lease } from "@/shared/mongo-lease";
import { describe, expect, it } from "vitest";
import type { CatalogEvent, CatalogEvents } from "./core/catalog-events";
import { GameModeService } from "./service";
import { MemoryProviderCatalogs } from "./transports/memory-provider-catalogs";
import { MemoryGameModeRepository } from "./transports/memory-repository";
import { clasica, mutableClock } from "./transports/tests/repository-contract";

// LO QUE EL CATÁLOGO ANUNCIA (`domino.config.*`): uno por cambio que se escribió, con el dueño del modo
// en la clave, y nada por lo que no cambió ni por lo que se rechazó.

const lease: Lease = {
  async within(_name, _ttlMs, work) {
    return work();
  },
};

function harness() {
  const clock = mutableClock();
  const told: CatalogEvent[] = [];
  const events: CatalogEvents = {
    announce: async (event) => {
      told.push(event);
    },
  };
  const service = new GameModeService(
    new MemoryGameModeRepository(clock),
    new MemoryProviderCatalogs(clock),
    lease,
    () => clock.now(),
    events,
  );
  return { service, told };
}

const gabo = { provider: null, name: "gabo" } as const;
const pepe = { provider: "parley", name: "pepe" } as const;

describe("GameModeService: los anuncios del catálogo", () => {
  it("un compartido creado, editado, dado de baja y reactivado", async () => {
    const { service, told } = harness();
    const mode = await service.create(gabo, clasica());
    await service.update(gabo, mode.uuid, { entryFee: 2 });
    await service.softDelete(gabo, mode.uuid);
    await service.reactivate(gabo, mode.uuid);
    expect(told.map((e) => e.topic)).toEqual([
      "domino.config.shared_game_mode.created",
      "domino.config.shared_game_mode.updated",
      "domino.config.shared_game_mode.deactivated",
      "domino.config.shared_game_mode.reactivated",
    ]);
    expect(told[0]?.payload).toEqual({
      gameSlug: "domino",
      occurredAt: expect.any(String),
      actor: { kind: "admin", name: "gabo" },
      modeId: mode.uuid,
      name: mode.name,
    });
  });

  it("los de un proveedor: sus propios, sus suscripciones, sus copias y su fuente", async () => {
    const { service, told } = harness();
    const shared = await service.create(gabo, clasica());
    await service.subscribe(pepe, shared.uuid, "parley");
    // Ya suscrito: nada cambia, nada se anuncia.
    await service.subscribe(pepe, shared.uuid, "parley");
    await service.createCopies(pepe, "parley");
    await service.setCatalogSource(pepe, "parley", "own");
    await service.setCatalogSource(pepe, "parley", "own");
    await service.unsubscribe(pepe, shared.uuid, "parley");
    expect(told.map((e) => [e.topic, e.payload.providerId])).toEqual([
      ["domino.config.shared_game_mode.created", undefined],
      ["domino.config.provider_game_mode.subscribed", "parley"],
      ["domino.config.provider_game_mode.copied", "parley"],
      ["domino.config.catalog_source.changed", "parley"],
      ["domino.config.provider_game_mode.unsubscribed", "parley"],
    ]);
    const own = await service.create(pepe, clasica({ name: "Mía" }));
    expect(told.at(-1)).toMatchObject({
      topic: "domino.config.provider_game_mode.created",
      payload: { providerId: "parley", modeId: own.uuid, actor: { kind: "admin", name: "pepe" } },
    });
  });

  it("un cambio rechazado no anuncia nada", async () => {
    const { service, told } = harness();
    const mode = await service.create(gabo, clasica());
    await expect(service.reactivate(gabo, mode.uuid)).rejects.toThrow();
    await expect(service.create(gabo, clasica())).rejects.toThrow();
    expect(told).toHaveLength(1);
  });
});
