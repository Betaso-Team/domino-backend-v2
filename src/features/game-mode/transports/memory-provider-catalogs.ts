import {
  type CatalogSource,
  type ProviderCatalog,
  type ProviderCatalogRepository,
  defaultCatalogOf,
} from "../core/catalog";
import type { Clock } from "./mongo-repository";

// LAS FUENTES DEL CATÁLOGO DE LA INSTANCIA SIN MONGO, y no un doble: la misma decisión que
// `MemoryGameModeRepository`. Lo mide el mismo contrato que al de Mongo.
export class MemoryProviderCatalogs implements ProviderCatalogRepository {
  private readonly catalogs = new Map<string, ProviderCatalog>();

  constructor(private readonly clock: Clock) {}

  async of(providerId: string): Promise<ProviderCatalog> {
    return this.catalogs.get(providerId) ?? defaultCatalogOf(providerId);
  }

  async nonShared(): Promise<readonly ProviderCatalog[]> {
    return [...this.catalogs.values()]
      .filter((catalog) => catalog.source !== "shared")
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  async set(
    providerId: string,
    source: CatalogSource,
    updatedBy: string,
  ): Promise<ProviderCatalog> {
    const catalog: ProviderCatalog = {
      providerId,
      source,
      updatedAt: new Date(this.clock.now()),
      updatedBy,
    };
    this.catalogs.set(providerId, catalog);
    return catalog;
  }
}
