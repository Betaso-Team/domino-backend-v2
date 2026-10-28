import { Mongo } from "@/shared/mongo";
import { MONGO_INT_URI } from "@/tests/int-services";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProviderCatalogRepository } from "../core/catalog";
import { MemoryProviderCatalogs } from "./memory-provider-catalogs";
import { MongoProviderCatalogs, PROVIDER_CATALOG_COLLECTION } from "./mongo-provider-catalogs";
import { BASE_INSTANT, type MutableClock, mutableClock } from "./tests/repository-contract";

// EL CONTRATO DE LAS FUENTES DEL CATÁLOGO, contra los dos adaptadores: el de memoria siempre, el de
// Mongo con `MONGO_INT_URI` (`src/tests/int-services.ts`).
function describeContract(
  label: string,
  harnessOf: () => { repository: ProviderCatalogRepository; clock: MutableClock },
): void {
  describe(label, () => {
    it("un operador sin registro está en `shared`, y no viaja en `nonShared`", async () => {
      const { repository } = harnessOf();

      expect(await repository.of("parley")).toEqual({
        providerId: "parley",
        source: "shared",
        updatedAt: null,
        updatedBy: null,
      });
      expect(await repository.nonShared()).toEqual([]);
    });

    it("`set` escribe un registro por operador, con quién y cuándo", async () => {
      const { repository, clock } = harnessOf();
      clock.set(BASE_INSTANT + 1_000);
      await repository.set("parley", "own", "pia");
      clock.set(BASE_INSTANT + 2_000);
      await repository.set("rival", "own", "rita");
      await repository.set("parley", "shared", "ana");

      expect(await repository.of("parley")).toEqual({
        providerId: "parley",
        source: "shared",
        updatedAt: new Date(BASE_INSTANT + 2_000),
        updatedBy: "ana",
      });
      expect(await repository.nonShared()).toEqual([
        {
          providerId: "rival",
          source: "own",
          updatedAt: new Date(BASE_INSTANT + 2_000),
          updatedBy: "rita",
        },
      ]);
    });
  });
}

describeContract("MemoryProviderCatalogs", () => {
  const clock = mutableClock();
  return { repository: new MemoryProviderCatalogs(clock), clock };
});

describe.skipIf(!MONGO_INT_URI)("MongoProviderCatalogs contra Mongo", () => {
  let mongo: Mongo;
  const collection = async () => await mongo.collection(PROVIDER_CATALOG_COLLECTION);

  beforeAll(() => {
    mongo = new Mongo(MONGO_INT_URI as string);
  });

  afterAll(async () => {
    await (await collection()).drop().catch(() => {});
    await mongo.close();
  });

  beforeEach(async () => {
    await (await collection()).deleteMany({});
  });

  describeContract("MongoProviderCatalogs (Mongo real)", () => {
    const clock = mutableClock();
    return { repository: new MongoProviderCatalogs(mongo, clock), clock };
  });

  it("deja un solo documento por operador", async () => {
    const repository = new MongoProviderCatalogs(mongo, mutableClock());
    await Promise.all([
      repository.set("parley", "own", "pia"),
      repository.set("parley", "shared", "ana"),
    ]);

    expect(await (await collection()).countDocuments({ providerId: "parley" })).toBe(1);
  });
});
